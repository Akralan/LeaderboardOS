import type { Value } from "../expr/evaluator.js";
import { ObserverRefusal, type EvaluateBinding, type EvaluateResult } from "./runtime.js";

/**
 * Les liaisons des capacités du catalogue
 * ---------------------------------------
 * La moitié exécutable du catalogue qui passe par des connecteurs : l'évaluation
 * par grille (`assess: {kind: ai_grid}`), et les observateurs `github_fetch` et
 * `kaggle_metadata`. Les mêmes chemins que les flows écrits à la main — la
 * capacité `evaluate` et ses sources de bundle, les connecteurs GitHub et
 * Kaggle —, pour qu'un template note et lise exactement comme eux.
 *
 * `BOUND_CAPABILITIES` est la liste que le catalogue ne doit jamais dépasser :
 * une capacité `v1` sans liaison validerait, publierait, puis échouerait au
 * premier geste.
 */

export const BOUND_CAPABILITIES = new Set(["http_proxy", "github_fetch", "kaggle_metadata"]);

/** Ce qu'une URL désigne pour la noter ou la lire. */
export type ArtifactRef =
  | { host: "github"; slug: string; branch?: string; url: string }
  | { host: "kaggle"; kind: "dataset" | "model"; ref: string; url: string };

/** `github.com/o/r(/tree/b)`, `kaggle.com/datasets/o/s`, `kaggle.com/models/o/s(/…)`. */
export function artifactOf(value: unknown): ArtifactRef | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  const github = /github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?(?:\/tree\/([^?#]+))?\/?(?:[?#]|$)/.exec(url);
  if (github) return { host: "github", slug: `${github[1]}/${github[2]}`, ...(github[3] ? { branch: github[3] } : {}), url };
  const kaggle = /kaggle\.com\/(datasets|models)\/([^/?#]+)\/([^/?#]+)/.exec(url);
  if (kaggle) return { host: "kaggle", kind: kaggle[1] === "datasets" ? "dataset" : "model", ref: `${kaggle[2]}/${kaggle[3]}`, url };
  return null;
}

/** La première URL d'artefact parmi les entrées d'une évaluation, à plat ou dans un enregistrement. */
function firstArtifact(values: readonly Value[]): ArtifactRef | null {
  for (const value of values) {
    const direct = artifactOf(value);
    if (direct) return direct;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = firstArtifact(Object.values(value as Record<string, Value>));
      if (nested) return nested;
    }
  }
  return null;
}

/** Le score d'une évaluation, ramené sur 0..1 : le `globalScore` est sur 0–9. */
export function scoreOf(globalScore: number): number {
  return Math.min(1, Math.max(0, globalScore / 9));
}

/** La source de bundle d'un artefact : l'historique d'une branche GitHub, ou le dernier état d'un artefact. */
export function bundleOf(artifact: ArtifactRef, snapshot: "history" | "latest"): { source: string; input: unknown } {
  if (artifact.host === "github" && snapshot === "history") {
    return { source: "github-snapshot", input: { slug: artifact.slug, ...(artifact.branch ? { branch: artifact.branch } : {}) } };
  }
  if (artifact.host === "github") return { source: "kaggle-artifact", input: { ref: artifact.slug, repoType: "github" } };
  return { source: "kaggle-artifact", input: { ref: artifact.ref, repoType: artifact.kind === "dataset" ? "kaggle_dataset" : "kaggle_model" } };
}

/**
 * `assess: {kind: ai_grid}` — la capacité `evaluate` du core sur la première URL
 * d'artefact des entrées ; les autres entrées vont au contexte de l'agent. Le
 * run est tracé au nom du flow du challenge. Une évaluation qui échoue refuse le
 * geste (502), sans effet.
 */
export async function evaluateGrid(request: EvaluateBinding): Promise<EvaluateResult> {
  const artifact = firstArtifact(request.inputs);
  if (!artifact) throw new ObserverRefusal(422, `The ${request.grid} evaluation needs a GitHub or Kaggle URL`);
  const context = request.inputs.filter((value) => value !== artifact.url && value !== null && value !== undefined);
  const description = [request.challenge.title, ...context.map((value) => (typeof value === "string" ? value : JSON.stringify(value)))].join("\n");

  const { evaluate } = await import("../../capabilities/evaluation.js");
  // Évaluée sur une contribution : le sujet est le sien, comme le challenge code le présente à l'agent.
  const contribution = request.contributionId
    ? await new (await import("../../database-service/repositories/index.js")).ContributionRepository().findById(request.contributionId)
    : null;
  const subject = contribution
    ? { title: contribution.title, type: request.grid, description: contribution.description, ref: request.challenge.uuid, userId: contribution.user_id }
    : { title: request.challenge.title, type: request.grid, description, ref: request.challenge.uuid, userId: request.userId };
  try {
    const { evaluation } = await evaluate({
      bundle: bundleOf(artifact, request.snapshot ?? (artifact.host === "github" ? "history" : "latest")),
      gridSlug: request.grid,
      subject,
      hasPriorEvaluation: Boolean(contribution?.evaluation),
      origin: {
        owner: request.challenge.type,
        handler: request.origin?.handler ?? "template.assess",
        payload: request.origin?.payload ?? { challengeId: request.challenge.uuid, userId: request.userId, grid: request.grid, url: artifact.url },
        challengeId: request.challenge.uuid,
        ...(request.contributionId ? { contributionId: request.contributionId } : {}),
      },
    });
    return { score: scoreOf(evaluation.globalScore), evaluation: { scores: evaluation.scores, globalScore: evaluation.globalScore } };
  } catch (error) {
    throw new ObserverRefusal(502, `The evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Les métriques qu'un template lit : la dernière version qui publie chacune, 0 quand aucune ne la publie. */
export const KAGGLE_METRICS = ["auc", "f1", "accuracy"] as const;

interface KaggleVersionLike {
  metrics?: Record<string, number | undefined>;
}

/** Comme le flow ML (`readKaggleMetric`) : la dernière version qui publie la métrique fait foi. */
export function latestMetrics(versions: readonly KaggleVersionLike[]): Record<(typeof KAGGLE_METRICS)[number], number> {
  const out = { auc: 0, f1: 0, accuracy: 0 };
  for (const name of KAGGLE_METRICS) {
    const values = versions.map((version) => version.metrics?.[name]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length) out[name] = values[values.length - 1];
  }
  return out;
}

async function connector(repo: { title: string; type: string; external_repo_id: string }, branch?: string) {
  const { ConnectorRegistry } = await import("../../connectors/registry.js");
  const created = await ConnectorRegistry.createConnector(repo, branch ? { branch } : undefined);
  if (!created) throw new ObserverRefusal(502, `No ${repo.type} connector available (missing credentials?)`);
  return created;
}

/** `kaggle_metadata {url}` — la nature de l'artefact, son titre, et ses métriques pour un modèle. */
async function kaggleMetadata(args: Record<string, Value>): Promise<Value> {
  const artifact = artifactOf(args.url);
  if (!artifact || artifact.host !== "kaggle") throw new ObserverRefusal(422, "kaggle_metadata needs a Kaggle dataset or model URL");
  const type = artifact.kind === "dataset" ? "kaggle_dataset" : "kaggle_model";
  const kaggle = await connector({ title: artifact.ref, type, external_repo_id: artifact.ref });
  try {
    await kaggle.connect();
    if (!kaggle.fetchRepoActivity) throw new ObserverRefusal(502, "The Kaggle connector cannot read activity");
    const payload = (await kaggle.fetchRepoActivity()).payload as {
      datasetMeta?: { title?: string };
      modelVersions?: { versions: KaggleVersionLike[] }[];
    };
    const versions = payload.modelVersions?.flatMap((model) => model.versions) ?? [];
    return {
      ref: artifact.ref,
      kind: artifact.kind,
      url: artifact.url,
      title: payload.datasetMeta?.title ?? artifact.ref,
      versions: versions.length,
      metrics: latestMetrics(versions),
    };
  } catch (error) {
    if (error instanceof ObserverRefusal) throw error;
    throw new ObserverRefusal(502, `Kaggle could not be read: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await kaggle.disconnect?.();
  }
}

/** `github_fetch {url}` — le dépôt tel qu'on le lit : sa branche, son dernier commit. */
async function githubFetch(args: Record<string, Value>): Promise<Value> {
  const artifact = artifactOf(args.url);
  if (!artifact || artifact.host !== "github") throw new ObserverRefusal(422, "github_fetch needs a GitHub repository URL");
  const github = await connector({ title: artifact.slug, type: "github", external_repo_id: artifact.slug }, artifact.branch);
  try {
    await github.connect();
    const commits = await github.fetchItems({ maxCommits: 100 });
    const latest = commits[0];
    return {
      slug: artifact.slug,
      url: artifact.url,
      branch: artifact.branch ?? "",
      commits: commits.length,
      last_commit: latest?.id ?? "",
      last_commit_at: typeof latest?.metadata?.date === "string" ? latest.metadata.date : "",
    };
  } catch (error) {
    throw new ObserverRefusal(502, `GitHub could not be read: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await github.disconnect?.();
  }
}

/** Les observateurs servis par un connecteur ; `http_proxy` est servi par le runtime lui-même. */
export async function observeConnector(capability: string, args: Record<string, Value>): Promise<Value> {
  switch (capability) {
    case "kaggle_metadata":
      return kaggleMetadata(args);
    case "github_fetch":
      return githubFetch(args);
    default:
      throw new ObserverRefusal(501, `No binding installed for capability ${capability}`);
  }
}
