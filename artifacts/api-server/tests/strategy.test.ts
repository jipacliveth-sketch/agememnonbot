import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/client";
import { strategies } from "../src/db/schema";

// Assumes `npm run db:seed` has been run against this DATABASE_URL.
describe("strategy listing", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("lists seeded strategies with AVAILABLE status", async () => {
    const available = await db.query.strategies.findMany({ where: eq(strategies.status, "AVAILABLE") });
    expect(available.length).toBeGreaterThan(0);

    const slugs = available.map((s) => s.slug);
    expect(slugs).toContain("meme-sniper");
  });

  it("seeded strategies are discoverable, while execution remains adapter-gated", async () => {
    const memeSniper = await db.query.strategies.findFirst({ where: eq(strategies.slug, "meme-sniper") });
    expect(memeSniper).toBeTruthy();
    expect(memeSniper!.enabled).toBe(true);
  });
});
