import type { UiScreen } from "../format/schema.js";
import { UI_SCREENS } from "../format/schema.js";
import type { TemplateIssue, TemplatePath } from "../issues.js";
import { gestureFields, segmentsOf } from "../compile/segments.js";
import { BINDING, LANE_TRIGGER_OF_SCREEN, SUBMISSION_FIELDS, UI_CATALOG, UI_COLUMNS, uiComponent, type UiPropKind } from "../ui/catalog.js";
import { overlaps } from "../ui/layout.js";
import type { NodeModel, TemplateModel } from "./format.js";

/**
 * Passe sur les écrans composés
 * -----------------------------
 * Un bloc `ui` qui a passé le format dit encore des choses fausses : un
 * composant hors catalogue, posé sur un écran qui ne l'admet pas, deux fois
 * quand il est unique, sans ce que le template doit déclarer, un argument
 * inconnu ou manquant, une lane qui n'existe pas ou qu'un autre acteur joue,
 * un bloc qui déborde de la grille. Tout cela refuse la publication. Deux
 * blocs qui se recouvrent se signalent seulement : l'écran reste lisible, en
 * colonne sur un téléphone.
 */

export function checkUi(model: TemplateModel): TemplateIssue[] {
  const ui = model.shell.ui;
  if (!ui) return [];
  const issues: TemplateIssue[] = [];
  const report = (path: TemplatePath, message: string) => issues.push({ pass: "reference", severity: "error", path, message });
  const shape = (path: TemplatePath, message: string, severity: "error" | "advisory" = "error") => issues.push({ pass: "shape", severity, path, message });
  const names = UI_CATALOG.map((spec) => spec.name).join(", ");
  const lanes = new Map(model.lanes.map((lane) => [lane.id, lane.entry.trigger]));
  const brokenLanes = model.broken.lanes;

  /** Un segment d'une lane : ses champs avec leur type écrit, s'il pose ou reprend un claim, et la ressource réclamée. */
  const segmentOf = (laneId: unknown, index = 0): { fields: Record<string, string>; opensClaim: boolean; needsClaim: boolean; claimed: string | null } | null => {
    const lane = typeof laneId === "string" ? model.lanes.find((candidate) => candidate.id === laneId) : undefined;
    if (!lane) return null;
    const segments = segmentsOf(lane);
    const segment = segments[index];
    if (!segment) return null;
    const claimAct = (nodes: NodeModel[]) => nodes.find((node) => node.family === "act" && node.body.claim);
    const claimIndex = segments.findIndex((candidate) => claimAct(candidate.nodes));
    const act = claimAct(segment.nodes);
    const claimed = act && act.family === "act" && act.body.claim && typeof act.body.claim.resource === "string" ? act.body.claim.resource : null;
    const fields: Record<string, string> = {};
    for (const gesture of segment.gestures) for (const [name, decl] of Object.entries(gestureFields(gesture))) fields[name] = typeof decl.type === "string" ? decl.type : "json";
    return { fields, opensClaim: index === claimIndex, needsClaim: claimIndex >= 0 && index > claimIndex, claimed };
  };
  /** Les champs du premier segment d'une lane : ce qu'un `picker` ou un `stepper` joue. */
  const firstCollectFields = (laneId: unknown): Record<string, string> | null => segmentOf(laneId)?.fields ?? null;
  const segmentIndexOf = (props: Record<string, unknown>) => (typeof props.segment === "number" && Number.isInteger(props.segment) && props.segment >= 0 ? props.segment : 0);
  /** Ce qu'un champ `ref(x)` désigne ; `$link` pour un champ `link` (id, author, title, url, members). */
  const pickedOf = (type: string | undefined): string | null => {
    if (!type) return null;
    const ref = /^ref\(\s*([a-z][a-z0-9_]*)\s*\)$/.exec(type);
    if (ref) return ref[1];
    return type === "link" ? "$link" : null;
  };
  const LINK_FIELDS = ["id", "author", "author_name", "title", "url", "members"];

  /**
   * Les variables d'un écran : qui les choisit, et ce qu'elles portent — une
   * instance d'une ressource (ses champs), ce qu'un geste a créé (`id`, et
   * les champs de la ressource réclamée si le segment pose un claim), une
   * étape à soumettre (`SUBMISSION_FIELDS`).
   */
  type ScreenVar = { block: string; resource: string | null; created: boolean; submission: boolean };
  let vars = new Map<string, ScreenVar>();

  for (const screen of UI_SCREENS) {
    const decl = ui[screen];
    if (!decl) continue;
    const seen = new Map<string, number>();
    const singles = new Map<string, number>();

    // Les choix d'abord : une liaison peut lire un bloc posé plus bas.
    vars = new Map();
    decl.blocks.forEach((block, index) => {
      if (!block.selects) return;
      const path: TemplatePath = ["ui", screen, "blocks", index, "selects"];
      const spec = uiComponent(block.component);
      if (!spec) return;
      if (!spec.selects) {
        report(path, `'${block.component}' chooses nothing for the screen — only picker, stepper and form do`);
        return;
      }
      const taken = vars.get(block.selects);
      if (taken) {
        report(path, `'$${block.selects}' is already chosen by block '${taken.block}'`);
        return;
      }
      const props = block.props ?? {};
      if (spec.selects === "submission") {
        vars.set(block.selects, { block: block.id, resource: null, created: false, submission: true });
        return;
      }
      if (spec.selects === "created") {
        // Un segment qui pose un claim rend la ressource réclamée : ses champs se lisent sur la variable.
        const segment = segmentOf(props.lane, segmentIndexOf(props));
        vars.set(block.selects, { block: block.id, resource: segment?.opensClaim ? segment.claimed : null, created: true, submission: false });
        return;
      }
      const fields = firstCollectFields(props.lane);
      const fieldName = typeof props.field === "string" ? props.field : fields ? Object.keys(fields).find((name) => pickedOf(fields[name])) : undefined;
      const resource = fields && fieldName ? pickedOf(fields[fieldName]) : null;
      vars.set(block.selects, { block: block.id, resource, created: false, submission: false });
    });

    decl.blocks.forEach((block, index) => {
      const path: TemplatePath = ["ui", screen, "blocks", index];
      const first = seen.get(block.id);
      if (first !== undefined) report([...path, "id"], `block '${block.id}' is already placed on this screen (block ${first})`);
      else seen.set(block.id, index);

      const spec = uiComponent(block.component);
      if (!spec) {
        report([...path, "component"], `unknown component '${block.component}' — the catalogue has ${names}`);
        return;
      }
      if (!spec.screens.includes(screen)) {
        report([...path, "component"], `'${block.component}' belongs to the ${spec.screens.join(" and ")} screen${spec.screens.length > 1 ? "s" : ""}, not to ${screen}`);
      }
      if (spec.single) {
        const before = singles.get(spec.name);
        if (before !== undefined) report([...path, "component"], `'${block.component}' is placed once per screen (already at block ${before})`);
        else singles.set(spec.name, index);
      }
      if (spec.requires === "board" && !model.shell.presentation?.board) report([...path, "component"], `'${block.component}' needs \`presentation.board: true\``);
      if (spec.requires === "workspace" && !model.shell.workspace) report([...path, "component"], `'${block.component}' needs a \`workspace\` declaration`);
      for (const laneId of spec.expects?.lanes ?? []) {
        if (!lanes.has(laneId) && !brokenLanes.has(laneId)) report([...path, "component"], `'${block.component}' plays the lane '${laneId}', which this template does not declare`);
      }
      if (spec.expects?.submissions && !model.shell.submissions) report([...path, "component"], `'${block.component}' needs a \`submissions\` declaration`);

      if (block.at.x + block.at.w > UI_COLUMNS) shape([...path, "at"], `block '${block.id}' overflows the ${UI_COLUMNS}-column grid (x ${block.at.x} + w ${block.at.w})`);
      if (block.at.w < spec.size.minW || block.at.h < spec.size.minH) {
        shape([...path, "at"], `'${block.component}' needs at least ${spec.size.minW}×${spec.size.minH}, got ${block.at.w}×${block.at.h}`, "advisory");
      }

      const props = block.props ?? {};
      for (const [name, prop] of Object.entries(spec.props)) {
        const value = props[name];
        if (value === undefined) {
          if (prop.required) report([...path, "props"], `'${block.component}' needs '${name}'`);
          continue;
        }
        if (prop.kind === "values") checkValues(props.lane, segmentIndexOf(props), value, [...path, "props", name]);
        else checkProp(prop.kind, name, value, screen, [...path, "props", name]);
      }
      if (block.component === "form" && typeof props.lane === "string" && lanes.has(props.lane) && !segmentOf(props.lane, segmentIndexOf(props))) {
        report([...path, "props", "segment"], `'${props.lane}' has no segment ${segmentIndexOf(props)}`);
      }
      // Un picker ou un stepper choisit par un champ ref ou link de son premier segment.
      if (spec.selects === "resource" && typeof props.lane === "string" && lanes.has(props.lane)) {
        const fields = firstCollectFields(props.lane);
        const fieldName = typeof props.field === "string" ? props.field : fields ? Object.keys(fields).find((name) => pickedOf(fields[name])) : undefined;
        if (!fields || !fieldName) report([...path, "props", "lane"], `'${block.component}' picks by a ref or link field of '${props.lane}', which collects none`);
        else if (!(fieldName in fields)) report([...path, "props", "field"], `'${props.lane}' collects no '${fieldName}' — it collects ${Object.keys(fields).join(", ")}`);
        else if (!pickedOf(fields[fieldName])) report([...path, "props", "field"], `'${fieldName}' is a ${fields[fieldName]}, not a ref or link field`);
      }
      for (const name of Object.keys(props)) {
        if (!(name in spec.props)) report([...path, "props", name], `'${block.component}' has no '${name}' — it takes ${Object.keys(spec.props).join(", ") || "nothing"}`);
      }
      checkShape(block.component, props, path);
    });

    // Le recouvrement, une fois par paire.
    decl.blocks.forEach((block, index) => {
      for (let other = index + 1; other < decl.blocks.length; other++) {
        const candidate = decl.blocks[other];
        if (overlaps(block.at, candidate.at)) shape(["ui", screen, "blocks", other, "at"], `blocks '${block.id}' and '${candidate.id}' overlap`, "advisory");
      }
    });
  }
  return issues;

  /** Une liaison `$name` ou `$name.field` : la variable est choisie sur cet écran, le champ existe sur ce qu'elle désigne. */
  function checkBinding(value: string, path: TemplatePath): boolean {
    const match = BINDING.exec(value);
    if (!match) return false;
    const [, name, field] = match;
    const variable = vars.get(name);
    if (!variable) {
      report(path, `'$${name}' is chosen by no block of this screen — a picker, a stepper or a form must \`selects: ${name}\``);
      return true;
    }
    if (!field) return true;
    if (variable.submission) {
      if (!(SUBMISSION_FIELDS as readonly string[]).includes(field)) report(path, `a submission step has ${SUBMISSION_FIELDS.join(", ")} — not '${field}'`);
      return true;
    }
    if (variable.created && !variable.resource) {
      if (field !== "id") report(path, `'$${name}' is what a form created: only '$${name}.id' is known`);
      return true;
    }
    if (variable.created && field === "id") return true;
    if (variable.resource === "$link") {
      if (!LINK_FIELDS.includes(field)) report(path, `a link has ${LINK_FIELDS.join(", ")} — not '${field}'`);
      return true;
    }
    if (!variable.resource) return true;
    const resource = model.shell.resources[variable.resource];
    if (resource && !(field in resource.fields) && !["id", "author", "author_name", "open", "closed", "verdict"].includes(field)) {
      report(path, `'${variable.resource}' has no field '${field}' — it has ${Object.keys(resource.fields).join(", ")}`);
    }
    return true;
  }

  /** `values` : des champs du segment joué, fixés par une liaison ou une valeur ; `claim_id` sur un segment qui reprend un claim. */
  function checkValues(laneId: unknown, index: number, value: unknown, path: TemplatePath) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      report(path, `'values' is a mapping of fields to $variables or values`);
      return;
    }
    const segment = typeof laneId === "string" && lanes.has(laneId) ? segmentOf(laneId, index) : null;
    for (const [field, bound] of Object.entries(value as Record<string, unknown>)) {
      if (segment && !(field in segment.fields) && !(field === "claim_id" && segment.needsClaim)) {
        const known = [...Object.keys(segment.fields), ...(segment.needsClaim ? ["claim_id"] : [])];
        report([...path, field], `segment ${index} of '${laneId}' collects no '${field}' — it collects ${known.join(", ") || "nothing"}`);
      }
      if (typeof bound === "string") checkBinding(bound, [...path, field]);
    }
  }

  function checkProp(kind: UiPropKind, name: string, value: unknown, screen: UiScreen, path: TemplatePath) {
    if (kind === "bool") {
      if (typeof value !== "boolean") report(path, `'${name}' is true or false`);
      return;
    }
    if (kind === "int") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) report(path, `'${name}' is a whole number`);
      return;
    }
    if (typeof value !== "string") {
      report(path, `'${name}' is a text`);
      return;
    }
    if (kind === "text" && value.startsWith("$")) {
      if (!checkBinding(value, path)) report(path, `'${value}' is not a binding — write $variable or $variable.field`);
      return;
    }
    if (kind === "resource") {
      if (!(value in model.shell.resources) && !model.broken.resources.has(value)) report(path, `unknown resource '${value}'`);
      return;
    }
    if (kind !== "lane") return;
    if (brokenLanes.has(value)) return;
    const trigger = lanes.get(value);
    if (trigger === undefined) {
      report(path, `unknown lane '${value}'`);
      return;
    }
    const expected = LANE_TRIGGER_OF_SCREEN[screen];
    if (trigger !== expected) report(path, `the ${screen} screen plays ${expected} lanes; '${value}' is a ${trigger} lane`);
  }

  /**
   * Ce que la forme des ressources et des lanes doit porter pour un composant
   * qui en lit des champs nommés (le scénario). Vérifié seulement sur ce qui
   * existe : une ressource ou une lane inconnue a déjà son diagnostic.
   */
  function checkShape(component: string, props: Record<string, unknown>, path: TemplatePath) {
    const resourceFields = (name: unknown): Record<string, string> | null => {
      const decl = typeof name === "string" ? model.shell.resources[name] : undefined;
      return decl ? Object.fromEntries(Object.entries(decl.fields).map(([field, spec]) => [field, typeof spec.type === "string" ? spec.type : "json"])) : null;
    };
    const laneFields = (name: unknown): Set<string> | null => {
      const lane = typeof name === "string" ? model.lanes.find((candidate) => candidate.id === name) : undefined;
      if (!lane) return null;
      const collected = new Set<string>();
      for (const node of lane.nodes) if (node.family === "collect") for (const field of Object.keys(node.body.fields)) collected.add(field);
      return collected;
    };
    const needFields = (what: string, fields: Record<string, string> | Set<string> | null, names: string[], at: string) => {
      if (!fields) return;
      const has = (name: string) => (fields instanceof Set ? fields.has(name) : name in fields);
      const missing = names.filter((name) => !has(name));
      if (missing.length) report([...path, "props", at], `'${component}': ${what} must have ${names.join(", ")} — missing ${missing.join(", ")}`);
    };
    const refsTo = (fields: Record<string, string>, target: string) => Object.entries(fields).some(([, type]) => new RegExp(`^ref\\(\\s*${target}\\s*\\)$`).test(type));

    if (component === "walkthrough" || component === "targets" || component === "walkthroughs") {
      const targets = resourceFields(props.targets);
      if (targets && !Object.values(targets).some((type) => type === "url")) report([...path, "props", "targets"], `'${component}' needs apps with an url field`);
    }
    if (component === "walkthrough" || component === "steps" || component === "walkthroughs") {
      needFields("steps", resourceFields(props.steps), ["title", "position"], "steps");
    }
    if (component === "walkthrough" || component === "walkthroughs") {
      // Une walkthrough désigne une app ; un résultat désigne une walkthrough et une étape, avec `result`.
      const resources = Object.keys(model.shell.resources).map((name) => [name, resourceFields(name) ?? {}] as const);
      const walkthrough = typeof props.targets === "string" ? resources.find(([, fields]) => refsTo(fields, props.targets as string)) : undefined;
      if (typeof props.targets === "string" && resourceFields(props.targets) && !walkthrough) {
        report([...path, "props", "targets"], `'${component}' needs a walkthrough resource with a ref(${props.targets}) field`);
      }
      const result = walkthrough ? resources.find(([, fields]) => refsTo(fields, walkthrough[0]) && typeof props.steps === "string" && refsTo(fields, props.steps)) : undefined;
      if (walkthrough && typeof props.steps === "string" && resourceFields(props.steps) && !result) {
        report([...path, "props", "steps"], `'${component}' needs a result resource with ref(${walkthrough[0]}) and ref(${props.steps}) fields`);
      }
      if (result) needFields(`the result resource '${result[0]}'`, result[1], ["result"], "steps");
    }
    if (component === "walkthrough") {
      needFields("the record lane", laneFields(props.record), ["result"], "record");
      needFields("the complete lane", laneFields(props.complete), ["global_feedback"], "complete");
    }
    if (component === "targets") needFields("the expose lane", laneFields(props.expose), ["contribution"], "expose");
    if (component === "steps") needFields("the add lane", laneFields(props.add), ["title"], "add");
  }
}
