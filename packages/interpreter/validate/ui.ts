import type { UiScreen } from "../format/schema.js";
import { UI_SCREENS } from "../format/schema.js";
import type { TemplateIssue, TemplatePath } from "../issues.js";
import { LANE_TRIGGER_OF_SCREEN, UI_CATALOG, UI_COLUMNS, uiComponent, type UiPropKind } from "../ui/catalog.js";
import { overlaps } from "../ui/layout.js";
import type { TemplateModel } from "./format.js";

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

  for (const screen of UI_SCREENS) {
    const decl = ui[screen];
    if (!decl) continue;
    const seen = new Map<string, number>();
    const singles = new Map<string, number>();
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
      if (spec.requires === "board" && !model.shell.presentation?.board) report([...path, "component"], "'board' needs `presentation.board: true`");
      if (spec.requires === "workspace" && !model.shell.workspace) report([...path, "component"], "'workspace' needs a `workspace` declaration");

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
        checkProp(prop.kind, name, value, screen, [...path, "props", name]);
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

  function checkProp(kind: UiPropKind, name: string, value: unknown, screen: UiScreen, path: TemplatePath) {
    if (kind === "bool") {
      if (typeof value !== "boolean") report(path, `'${name}' is true or false`);
      return;
    }
    if (typeof value !== "string") {
      report(path, `'${name}' is a text`);
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
