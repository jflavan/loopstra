import type { Section } from "../types";
import { budgets } from "./budgets";
import { commands } from "./commands";

/** In the order `loopstra setup` asks them. */
export const SECTIONS: Section[] = [budgets, commands];
