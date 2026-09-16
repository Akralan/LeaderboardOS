import { inArray } from "drizzle-orm";
import type { Challenge } from "../domain/entities.js";
import { challenges, db, projects, users } from "../db/drizzle.js";
import { ChallengeRepository } from "../repositories/index.js";

/**
 * Les jeux de données des tests d'intégration
 * -------------------------------------------
 * La base de `DATABASE_URL` est une vraie base de développement : un test n'y
 * efface jamais ce qu'il n'a pas créé. Un \`IntegrationScope\` retient les
 * comptes, projets et challenges qu'il pose, et \`cleanup()\` les supprime —
 * ressources, claims, contributions et ledger suivent en cascade.
 */
export interface IntegrationScope {
  /** Des comptes, rendus par leur nom de test : `{ u1: "<uuid>", … }`. */
  users(names: readonly string[]): Promise<Record<string, string>>;
  /** Un challenge et son projet, relus par le repository comme le dispatcher le lit. */
  challenge(values: { type: string; pool: number; flowConfig: Record<string, unknown>; rewardRules: unknown; status?: string }): Promise<Challenge>;
  cleanup(): Promise<void>;
}

export function integrationScope(): IntegrationScope {
  const created = { users: [] as string[], projects: [] as string[], challenges: [] as string[] };
  const tag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  return {
    async users(names) {
      const rows = await db
        .insert(users)
        .values(names.map((name) => ({ role: name === "admin" ? "admin" : "contributor", full_name: `${tag} ${name}` })))
        .returning({ uuid: users.uuid });
      created.users.push(...rows.map((row) => row.uuid));
      return Object.fromEntries(names.map((name, i) => [name, rows[i].uuid]));
    },

    async challenge(values) {
      const [project] = await db.insert(projects).values({ title: tag }).returning({ uuid: projects.uuid });
      created.projects.push(project.uuid);
      const title = `${tag} ${created.challenges.length + 1}`;
      const [row] = await db
        .insert(challenges)
        .values({
          title,
          slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          status: values.status ?? "active",
          type: values.type,
          contribution_points_reward: values.pool,
          project_id: project.uuid,
          flow_config: values.flowConfig,
          flow_config_version: 1,
          reward_rules: values.rewardRules,
        })
        .returning({ uuid: challenges.uuid });
      created.challenges.push(row.uuid);
      const challenge = await new ChallengeRepository().findById(row.uuid);
      if (!challenge) throw new Error("[integration] the seeded challenge does not read back");
      return challenge;
    },

    async cleanup() {
      if (created.challenges.length) await db.delete(challenges).where(inArray(challenges.uuid, created.challenges));
      if (created.projects.length) await db.delete(projects).where(inArray(projects.uuid, created.projects));
      if (created.users.length) await db.delete(users).where(inArray(users.uuid, created.users));
      created.users = [];
      created.projects = [];
      created.challenges = [];
    },
  };
}
