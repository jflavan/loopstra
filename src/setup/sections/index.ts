import type { Section } from "../types";
import { budgets } from "./budgets";
import { chat } from "./chat";
import { commands } from "./commands";
import { gates } from "./gates";
import { github } from "./github";

/** In the order `loopstra setup` asks them. */
export const SECTIONS: Section[] = [budgets, commands, gates, github, chat];
