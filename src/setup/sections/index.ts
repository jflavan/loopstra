import type { Section } from "../types";
import { agents } from "./agents";
import { budgets } from "./budgets";
import { chat } from "./chat";
import { commands } from "./commands";
import { gates } from "./gates";
import { github } from "./github";
import { models } from "./models";
import { standards } from "./standards";

/** In the order `loopstra setup` asks them. */
export const SECTIONS: Section[] = [budgets, commands, gates, github, chat, models, agents, standards];
