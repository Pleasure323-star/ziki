import type { Prisma, PrismaClient } from "@prisma/client";
import { award } from "@/lib/points/award";
import { POINTS_PER_DOLLAR } from "@/lib/points/rules";

type Db = PrismaClient | Prisma.TransactionClient;

/** What every new account gets: $0.67. */
export const SIGNUP_BONUS_DOLLARS = 0.67;
export const SIGNUP_BONUS_POINTS = Math.round(SIGNUP_BONUS_DOLLARS * POINTS_PER_DOLLAR);

/**
 * The signup bonus (#signup-bonus). Points live in an organisation, so it is
 * paid in the first one the person joins or creates, and only once per
 * account: its source key is the account, so later organisations add nothing.
 */
export async function awardSignupBonus(db: Db, userId: string, tenantId: string): Promise<boolean> {
  return award(db, {
    tenantId,
    userId,
    bugId: null,
    role: "signup",
    points: SIGNUP_BONUS_POINTS,
    sourceKey: `signup:${userId}`,
  });
}
