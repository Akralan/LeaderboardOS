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
const SOURCE = readFileSync(path.join(ROOT, "content/templates/endpoint-check/template.yaml"), "utf8").replace(/\r\n/g, "\n");

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
