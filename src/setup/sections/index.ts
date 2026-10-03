import type { Section } from "../types";
import { budgets } from "./budgets";
import { commands } from "./commands";
import { gates } from "./gates";

/** In the order `loopstra setup` asks them. */
export const SECTIONS: Section[] = [budgets, commands, gates];
