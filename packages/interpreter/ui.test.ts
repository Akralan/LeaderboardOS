import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTemplateSource } from "./check.js";
import { describeTemplate } from "./describe.js";
import { defaultScreen, freeSpot, overlaps } from "./ui/layout.js";

/**
 * Les écrans composés (catalogue UI)
 * ----------------------------------
 * Un template pose des composants du catalogue sur une grille ; le validateur
 * refuse ce que le catalogue ne connaît pas, la surface porte les écrans tels
 * quels, et la mise en page par défaut reproduit ce que le client empile.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** Un template système sans les écrans qu'il compose lui-même : les tests posent les leurs. */
const bare = (yaml: string) => yaml.replace(/\r\n/g, "\n").replace(/\nui:[\s\S]*$/, "\n");
const SOURCE = bare(readFileSync(path.join(ROOT, "content/templates/endpoint-check/template.yaml"), "utf8"));

const withUi = (ui: string) => `${SOURCE.trimEnd()}\n\nui:\n${ui}\n`;

const errorsOf = (source: string) => checkTemplateSource(source, "endpoint-check").errors.map((issue) => [issue.pass, issue.path.join("."), issue.message]);
const advisoriesOf = (source: string) => checkTemplateSource(source, "endpoint-check").advisories.map((issue) => [issue.pass, issue.path.join("."), issue.message]);

describe("a composed screen", () => {
  it("validates and reaches the surface as written", () => {
    const source = withUi(
      [
        "  contributor:",
        "    blocks:",
        "      - {id: intro, component: text, at: {x: 0, y: 0, w: 12, h: 2}, props: {title: Welcome, body: Review a case.}}",
        "      - {id: review, component: lane, at: {x: 0, y: 2, w: 8, h: 6}, props: {lane: reviewer}}",
        "      - {id: mine, component: mine, at: {x: 8, y: 2, w: 4, h: 6}}",
        "  manage:",
        "    blocks:",
        "      - {id: admin, component: lane, at: {x: 0, y: 0, w: 12, h: 5}, props: {lane: admin}}",
        "      - {id: overview, component: overview, at: {x: 0, y: 5, w: 12, h: 4}}",
      ].join("\n")
    );
    expect(errorsOf(source)).toEqual([]);
    const { surface } = describeTemplate(source, "endpoint-check");
    expect(surface.ui?.contributor?.blocks.map((block) => `${block.id}:${block.component}@${block.at.x},${block.at.y} ${block.at.w}x${block.at.h}`)).toEqual([
      "intro:text@0,0 12x2",
      "review:lane@0,2 8x6",
      "mine:mine@8,2 4x6",
    ]);
    expect(surface.ui?.contributor?.blocks[2].props).toEqual({});
    expect(surface.ui?.manage?.blocks.map((block) => block.id)).toEqual(["admin", "overview"]);
  });

  it("leaves the surface without ui when the template composes nothing", () => {
    expect(describeTemplate(SOURCE, "endpoint-check").surface.ui).toBeUndefined();
  });

  it("refuses what the catalogue does not know", () => {
    const source = withUi(
      [
        "  contributor:",
        "    blocks:",
        "      - {id: a, component: carousel, at: {x: 0, y: 0, w: 12, h: 2}}",
        "      - {id: b, component: overview, at: {x: 0, y: 2, w: 12, h: 2}}",
        "      - {id: c, component: lane, at: {x: 0, y: 4, w: 12, h: 4}, props: {lane: admin}}",
        "      - {id: d, component: lane, at: {x: 0, y: 8, w: 12, h: 4}, props: {lane: nowhere, extra: 1}}",
        "      - {id: e, component: lane, at: {x: 0, y: 12, w: 12, h: 4}}",
        "      - {id: e, component: mine, at: {x: 0, y: 16, w: 12, h: 4}}",
        "      - {id: f, component: mine, at: {x: 6, y: 20, w: 12, h: 4}}",
        "      - {id: g, component: board, at: {x: 0, y: 24, w: 12, h: 4}}",
      ].join("\n")
    );
    expect(errorsOf(source)).toEqual([
      ["reference", "ui.contributor.blocks.0.component", expect.stringMatching(/unknown component 'carousel'/)],
      ["reference", "ui.contributor.blocks.1.component", "'overview' belongs to the manage screen, not to contributor"],
      ["reference", "ui.contributor.blocks.2.props.lane", "the contributor screen plays user lanes; 'admin' is a admin lane"],
      ["reference", "ui.contributor.blocks.3.props.lane", "unknown lane 'nowhere'"],
      ["reference", "ui.contributor.blocks.3.props.extra", "'lane' has no 'extra' — it takes lane"],
      ["reference", "ui.contributor.blocks.4.props", "'lane' needs 'lane'"],
      ["reference", "ui.contributor.blocks.5.id", "block 'e' is already placed on this screen (block 4)"],
      ["reference", "ui.contributor.blocks.6.component", "'mine' is placed once per screen (already at block 5)"],
      ["reference", "ui.contributor.blocks.7.component", "'board' needs `presentation.board: true`"],
      ["shape", "ui.contributor.blocks.6.at", "block 'f' overflows the 12-column grid (x 6 + w 12)"],
    ]);
  });

  it("only advises on overlapping or cramped blocks", () => {
    const source = withUi(
      [
        "  manage:",
        "    blocks:",
        "      - {id: overview, component: overview, at: {x: 0, y: 0, w: 8, h: 4}}",
        "      - {id: resources, component: resources, at: {x: 4, y: 2, w: 8, h: 2}}",
      ].join("\n")
    );
    expect(errorsOf(source)).toEqual([]);
    expect(advisoriesOf(source).filter(([pass]) => pass === "shape")).toEqual([
      ["shape", "ui.manage.blocks.1.at", "'resources' needs at least 6×3, got 8×2"],
      ["shape", "ui.manage.blocks.1.at", "blocks 'overview' and 'resources' overlap"],
    ]);
  });

  it("drops an unreadable ui block with a format error, keeping the rest of the draft analyzed", () => {
    const report = checkTemplateSource(withUi("  contributor: {blocks: [{id: a, component: text, at: {x: 0, y: 0, w: 13, h: 1}}]}"), "endpoint-check");
    expect(report.errors.map((issue) => [issue.pass, issue.path.join(".")])).toEqual([["format", "ui.contributor.blocks.0.at.w"]]);
    expect(report.model).toBeNull();
  });
});

describe("the layout geometry", () => {
  it("writes the generated stack as full-width blocks", () => {
    const source = { lanes: [{ id: "admin", trigger: "admin" }, { id: "reviewer", trigger: "user" }, { id: "author", trigger: "user" }], board: true, workspace: false };
    expect(defaultScreen(source, "contributor").map((block) => `${block.id}:${block.component}@${block.at.y}+${block.at.h}`)).toEqual([
      "board:board@0+4",
      "reviewer:lane@4+6",
      "author:lane@10+6",
      "mine:mine@16+4",
    ]);
    expect(defaultScreen(source, "manage").map((block) => block.id)).toEqual(["admin", "overview", "resources"]);
    expect(defaultScreen(source, "manage")[0].props).toEqual({ lane: "admin" });
  });

  it("finds the first free spot, reading the grid row by row", () => {
    const blocks = [{ at: { x: 0, y: 0, w: 8, h: 2 } }, { at: { x: 0, y: 2, w: 12, h: 1 } }];
    expect(freeSpot(blocks, 4, 2)).toEqual({ x: 8, y: 0, w: 4, h: 2 });
    expect(freeSpot(blocks, 6, 1)).toEqual({ x: 0, y: 3, w: 6, h: 1 });
    expect(overlaps({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 })).toBe(false);
    expect(overlaps({ x: 0, y: 0, w: 3, h: 2 }, { x: 2, y: 1, w: 2, h: 2 })).toBe(true);
  });
});

describe("the scenario components", () => {
  const JOURNEY = readFileSync(path.join(ROOT, "content/templates/journey-validation/template.yaml"), "utf8").replace(/\r\n/g, "\n");

  it("compose the journey-validation template's screens, whose surface names the referenced resources", () => {
    const { surface } = describeTemplate(JOURNEY, "journey-validation");
    expect(surface.ui?.contributor?.blocks.map((block) => `${block.component}${block.selects ? `>$${block.selects}` : ""}`)).toEqual([
      "picker>$app",
      "form>$run",
      "frame",
      "stepper>$step",
      "form",
      "form",
    ]);
    expect(surface.ui?.manage?.blocks.map((block) => block.component)).toEqual(["pool", "targets", "steps", "walkthroughs"]);
    const walkthrough = surface.resources.find((resource) => resource.type === "walkthrough");
    expect(walkthrough?.fields).toEqual([{ name: "app", kind: "ref", resource: "app" }]);
    const result = surface.resources.find((resource) => resource.type === "step_result");
    expect(result?.fields.find((field) => field.name === "result")).toEqual({ name: "result", kind: "enum", values: ["passed", "failed", "blocked"] });
    expect(result?.fields.find((field) => field.name === "comment")).toEqual({ name: "comment", kind: "string", optional: true });
  });

  it("check the shape of what they play: an url on the apps, ordered steps, a result resource, the lanes' fields", () => {
    const source = JOURNEY.replace(/\nui:[\s\S]*$/, "\n") + [
      "ui:",
      "  contributor:",
      "    blocks:",
      "      - {id: w, component: walkthrough, at: {x: 0, y: 0, w: 12, h: 8}, props: {targets: step, steps: app, open: open, record: open, complete: open}}",
      "",
    ].join("\n");
    const errors = checkTemplateSource(source, "journey-validation").errors.map((issue) => [issue.path.join("."), issue.message]);
    expect(errors).toEqual([
      ["ui.contributor.blocks.0.props.targets", "'walkthrough' needs apps with an url field"],
      ["ui.contributor.blocks.0.props.steps", "'walkthrough': steps must have title, position — missing title, position"],
      ["ui.contributor.blocks.0.props.steps", "'walkthrough' needs a result resource with ref(step_result) and ref(app) fields"],
      ["ui.contributor.blocks.0.props.record", "'walkthrough': the record lane must have result — missing result"],
      ["ui.contributor.blocks.0.props.complete", "'walkthrough': the complete lane must have global_feedback — missing global_feedback"],
    ]);
  });
});

describe("the hand-written flow screens in the catalogue", () => {
  it("require the lanes and declarations they play, by name", () => {
    const source = withUi(
      [
        "  contributor:",
        "    blocks:",
        "      - {id: p, component: project, at: {x: 0, y: 0, w: 12, h: 8}}",
        "      - {id: s, component: submissions, at: {x: 0, y: 8, w: 12, h: 8}}",
        "      - {id: a, component: annotation, at: {x: 0, y: 16, w: 12, h: 8}}",
        "  manage:",
        "    blocks:",
        "      - {id: c, component: campaign, at: {x: 0, y: 0, w: 12, h: 8}}",
        "      - {id: k, component: compute, at: {x: 0, y: 8, w: 12, h: 3}}",
      ].join("\n")
    );
    expect(errorsOf(source)).toEqual([
      ["reference", "ui.contributor.blocks.0.component", "'project' needs `presentation.board: true`"],
      ["reference", "ui.contributor.blocks.0.component", "'project' plays the lane 'project_evaluation', which this template does not declare"],
      ["reference", "ui.contributor.blocks.1.component", "'submissions' needs a `submissions` declaration"],
      ["reference", "ui.contributor.blocks.2.component", "'annotation' plays the lane 'annotator', which this template does not declare"],
      ["reference", "ui.manage.blocks.0.component", "'campaign' plays the lane 'import', which this template does not declare"],
      ["reference", "ui.manage.blocks.0.component", "'campaign' plays the lane 'resolve', which this template does not declare"],
    ]);
  });

  it("accept them on the templates they come from", () => {
    const compose = (key: string, ui: string) => `${bare(readFileSync(path.join(ROOT, `content/templates/${key}/template.yaml`), "utf8")).trimEnd()}\n\nui:\n${ui}\n`;
    const code = compose("code", "  contributor: {blocks: [{id: p, component: project, at: {x: 0, y: 0, w: 12, h: 8}}]}");
    const ml = compose("ml", "  contributor: {blocks: [{id: s, component: submissions, at: {x: 0, y: 0, w: 12, h: 8}}, {id: k, component: compute, at: {x: 0, y: 8, w: 12, h: 3}}]}\n  manage: {blocks: [{id: l, component: submission_list, at: {x: 0, y: 0, w: 12, h: 5}}]}");
    const annotation = compose("data-annotation", "  contributor: {blocks: [{id: a, component: annotation, at: {x: 0, y: 0, w: 12, h: 8}}]}\n  manage: {blocks: [{id: c, component: campaign, at: {x: 0, y: 0, w: 12, h: 8}}]}");
    for (const [key, source] of [["code", code], ["ml", ml], ["data-annotation", annotation]] as const) {
      expect(checkTemplateSource(source, key).errors, key).toEqual([]);
    }
  });
});

describe("the system templates", () => {
  it("compose their screens on the catalogue", () => {
    const composed = (key: string) => {
      const { surface } = describeTemplate(readFileSync(path.join(ROOT, `content/templates/${key}/template.yaml`), "utf8").replace(/\r\n/g, "\n"), key);
      return [surface.ui?.contributor?.blocks.map((block) => block.component), surface.ui?.manage?.blocks.map((block) => block.component)];
    };
    expect(composed("code")).toEqual([["project", "activity"], ["pool", "participants", "activity"]]);
    expect(composed("ml")).toEqual([["submissions", "metrics"], ["submission_list", "metrics", "compute"]]);
    expect(composed("data-annotation")).toEqual([["annotation"], ["campaign"]]);
    expect(composed("endpoint-check")).toEqual([["lane", "lane", "lane", "mine"], ["lane", "lane", "lane", "pool", "overview", "resources"]]);
  });
});

describe("the screen's variables", () => {
  const JOURNEY = bare(readFileSync(path.join(ROOT, "content/templates/journey-validation/template.yaml"), "utf8"));
  const journeyWith = (blocks: string[]) => `${JOURNEY.trimEnd()}\n\nui:\n  contributor:\n    blocks:\n${blocks.map((block) => `      - ${block}`).join("\n")}\n`;
  const errors = (source: string) => checkTemplateSource(source, "journey-validation").errors.map((issue) => [issue.path.join("."), issue.message]);

  it("let a form fix its fields on what a picker, a stepper or another form chose", () => {
    const source = journeyWith([
      "{id: apps, component: picker, selects: app, at: {x: 0, y: 0, w: 4, h: 6}, props: {lane: open, status: walkthrough}}",
      "{id: start, component: form, selects: run, at: {x: 4, y: 0, w: 8, h: 2}, props: {lane: open, values: {app: $app}}}",
      "{id: app, component: frame, at: {x: 4, y: 2, w: 8, h: 4}, props: {url: $app.app_url}}",
      "{id: steps, component: stepper, selects: step, at: {x: 0, y: 6, w: 4, h: 4}, props: {lane: record}}",
      "{id: record, component: form, at: {x: 4, y: 6, w: 8, h: 4}, props: {lane: record, values: {walkthrough: $run, step: $step}}}",
    ]);
    expect(errors(source)).toEqual([]);
  });

  it("refuse a variable nobody chooses, a field the choice does not have, a field the segment does not collect", () => {
    const source = journeyWith([
      "{id: apps, component: picker, selects: app, at: {x: 0, y: 0, w: 4, h: 6}, props: {lane: open}}",
      "{id: twice, component: picker, selects: app, at: {x: 4, y: 0, w: 4, h: 6}, props: {lane: open}}",
      "{id: quiet, component: frame, selects: nope, at: {x: 8, y: 0, w: 4, h: 6}, props: {url: $app.app_url}}",
      "{id: app, component: frame, at: {x: 0, y: 6, w: 4, h: 4}, props: {url: $app.homepage}}",
      "{id: start, component: form, selects: run, at: {x: 4, y: 6, w: 4, h: 4}, props: {lane: open, values: {app: $walk, target: $app}}}",
      "{id: record, component: form, at: {x: 8, y: 6, w: 4, h: 4}, props: {lane: record, values: {walkthrough: $run.app}}}",
      "{id: text, component: frame, at: {x: 0, y: 10, w: 4, h: 4}, props: {url: $}}",
    ]);
    expect(errors(source)).toEqual([
      ["ui.contributor.blocks.1.selects", "'$app' is already chosen by block 'apps'"],
      ["ui.contributor.blocks.2.selects", "'frame' chooses nothing for the screen — only picker, stepper and form do"],
      ["ui.contributor.blocks.3.props.url", "'app' has no field 'homepage' — it has contribution, app_url"],
      ["ui.contributor.blocks.4.props.values.app", "'$walk' is chosen by no block of this screen — a picker, a stepper or a form must `selects: walk`"],
      ["ui.contributor.blocks.4.props.values.target", "'open' collects no 'target' — it collects app"],
      ["ui.contributor.blocks.5.props.values.walkthrough", "'$run' is what a form created: only '$run.id' is known"],
      ["ui.contributor.blocks.6.props.url", "'$' is not a binding — write $variable or $variable.field"],
    ]);
  });

  it("refuse a picker on a lane that picks nothing", () => {
    const source = journeyWith(["{id: apps, component: picker, selects: app, at: {x: 0, y: 0, w: 4, h: 6}, props: {lane: complete, field: global_feedback}}"]);
    expect(errors(source)).toEqual([["ui.contributor.blocks.0.props.field", "'global_feedback' is a string, not a ref or link field"]]);
  });
});
