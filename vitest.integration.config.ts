import "dotenv/config";
import { defineConfig } from "vitest/config";

/**
 * Les tests d'intégration — sur un vrai Postgres
 * ----------------------------------------------
 * `npm run test:integration` lance les fichiers `*.integration.test.ts` sur la
 * base de `DATABASE_URL`, un fichier à la fois. Ils n'effacent rien de ce
 * qu'ils n'ont pas créé : chaque test pose ses propres comptes, projet et
 * challenges, et les supprime à la fin (tout le reste suit en cascade). Ce qui
 * parcourt tous les challenges d'un flow — un job d'audit — est restreint aux
 * challenges du test. `npm test` ne voit pas ces fichiers.
 */
export default defineConfig({
  test: {
    name: "integration",
    globals: true,
    environment: "node",
    include: ["packages/**/*.integration.test.ts", "content/**/*.integration.test.ts"],
    setupFiles: ["./vitest.platform.setup.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
