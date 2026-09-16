/**
 * Le banc de l'agent auteur (note §2)
 * -----------------------------------
 * Une phrase par flow canonique : l'agent doit en tirer un template valide.
 * Mesure : valide dès le premier tour, valide après réparation, et, pour les
 * cas de refine, rien d'autre que ce que la consigne touche. Le banc appelle
 * le vrai modèle : il ne tourne pas avec les tests, mais à la main
 * (`npm run templates:author-bench`), à chaque changement de prompt ou de modèle.
 */

export interface BenchCase {
  name: string;
  description: string;
  /** Une consigne de refine appliquée au brouillon obtenu, et ce qu'elle doit changer. */
  refine?: { instruction: string; touches: readonly string[] };
}

export const BENCH: readonly BenchCase[] = [
  {
    name: "data-annotation",
    description: "Annotators label images one at a time under 3-way redundancy; hidden gold cases maintain a lagged accuracy that weights pay and gates sensitive items; items resolve by strict plurality or become contested for an admin to settle; a weekly sampled audit claws back disagreeing labels.",
    refine: { instruction: "make golds 20% of what annotators draw", touches: ["params"] },
  },
  {
    name: "endpoint-check",
    description: "Medical professionals verify deployed ML endpoints submitted in a source challenge: authors upload reference cases (input and expected output files), reviewers probe an endpoint with a case, write an observation, then see the expected output and give a works/broken verdict; five verdicts resolve a target by majority and the majority side is paid from the pool.",
  },
  {
    name: "bug-bounty",
    description: "Anyone reports a security issue with a description and a proof of concept; a triage role claims reports exclusively and routes each to a new vulnerability or an existing duplicate; only the first reporter of a novel vulnerability is paid, by severity tier.",
  },
  {
    name: "design-contest",
    description: "Designers submit one entry during the contest window; at closure a jury scores the entries and the podium is paid by rank from the pool.",
  },
  {
    name: "developer-onboarding",
    description: "A newcomer walks through onboarding steps; each step gives an instruction, checks on GitHub that it really happened, and pays a small fixed reward.",
  },
  {
    name: "endpoint-validation",
    description: "Qualified reviewers verify deployed submissions from a source challenge against peer-authored ground-truth cases; a quorum of verdicts closes each submission as works or broken.",
  },
  {
    name: "graded-submission",
    description: "Contributors submit a typed artifact (a repository or a notebook URL), trigger an AI evaluation against a grid themselves, and are paid by score until the pool is drained.",
    refine: { instruction: "add an admin lane that can close a submission as rejected", touches: ["lanes", "resources"] },
  },
  {
    name: "journey-validation",
    description: "Qualified reviewers walk a deployed application through an ordered user journey, one pass/fail verdict per step with a comment; each reviewer's journey verdict feeds a quorum over the application, majority side paid.",
  },
  {
    name: "localization",
    description: "Translators claim source strings exclusively and submit a translation; native reviewers approve or reject it; approval pays the translator per string, rejection reopens the string.",
  },
  {
    name: "sandbox-project",
    description: "A contributor proposes their own project and works on it; admin-defined milestones pay from the pool when an admin validates them; the contributor can self-evaluate for feedback without pay.",
  },
  {
    name: "social-amplification",
    description: "Contributors publish posts about the product and declare the post URL; after a week an admin records the engagement and the post is paid by engagement tier.",
  },
  {
    name: "staked-grant-review",
    description: "Reviewers review grant applications, each application by 3 reviewers who give a score; when 3 scores arrive the application resolves at the median and reviewers close to it are paid.",
  },
];
