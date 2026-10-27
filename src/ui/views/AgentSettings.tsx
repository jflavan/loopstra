import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { AgentFilesOp, AgentsView, AgentStepRow, LibraryItemView, SourceItems } from "../../console/types";
import { choicesFor, effective, fromNote, listText, parseList, withChosen, type Field } from "../agent-settings";
import { listSource, sendAgentFiles, sendSetting } from "../requests";
import { toast } from "../store";

/*
 * The Agents section of the Settings page: which agent each step runs as and what it may use, the
 * teams, and the agents and skills the steps can name. Every change is a request the loop applies and
 * commits; like the models above, one at a time, through the page's `submit`.
 */

type Sent = Awaited<ReturnType<typeof sendSetting>>;
type OnDone = (d: { ok: boolean; text: string }) => void;
/** Sends one change through the page (see Settings): `key` is where its waiting note shows; `after` hears whether the loop saved it. */
export type Submit = (key: string, send: (done: OnDone) => Promise<Sent>, after?: (ok: boolean) => void) => Promise<void>;

interface Props {
  view: AgentsView | null;
  failed: boolean;
  /** Counts the page's reads: controls keyed by it are drawn again, so a refused change shows what the file holds. */
  rev: number;
  /** A change waits for the loop: nothing else may be sent. */
  locked: boolean;
  /** The waiting note and its Cancel, beside the control whose key it is. */
  wait: (key: string) => ComponentChildren;
  submit: Submit;
}

/** What the page offers to write, given to each part of the section. */
interface Writes { view: AgentsView; rev: number; locked: boolean; wait: Props["wait"]; setting: (path: string, value: string | string[] | null, after?: (ok: boolean) => void) => void; files: (key: string, op: AgentFilesOp, after?: (ok: boolean) => void) => void }

const FIELD_LABELS: Record<Field, string> = { agent: "agent", subagents: "subagents", teams: "teams", skills: "skills", tools: "tools", mcp_tools: "MCP tools" };
const LIST_FIELDS: Field[] = ["subagents", "teams", "skills"];
const CHAT_WARNING = "Anyone allowed to chat can steer these tools.";
const TEAM_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FROM_TITLES: Record<LibraryItemView["from"], string> = { repo: "In the repo", personal: "On this machine", plugin: "From plugins" };

const asList = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** The name an item gets in the repository: a plugin's `plugin:name` becomes `name`. */
const repoName = (name: string) => name.slice(name.indexOf(":") + 1);
const usedText = (usedBy: string[]) => (usedBy.length ? `used by ${usedBy.join(", ")}` : "not used");

export function AgentSettings(p: Props) {
  const view = p.view;
  if (!view) return <><h2>Agents</h2><p class="muted">{p.failed ? "The agents could not be read." : "Loading…"}</p></>;
  if (view.problem !== null) return <><h2>Agents</h2><div class="callout bad" role="alert"><strong>The agents cannot be shown.</strong> {view.problem}</div></>;
  const version = view.version;
  const w: Writes = {
    view, rev: p.rev, locked: p.locked, wait: p.wait,
    setting: (path, value, after) => {
      if (!version) return;
      void p.submit(path, (done) => sendSetting({ kind: "settings", path, value, version }, done), after);
    },
    files: (key, op, after) => void p.submit(key, (done) => sendAgentFiles(op, done), after),
  };
  // Fails first; each keeps its order otherwise.
  const problems = [...view.problems].sort((a, b) => Number(a.level !== "fail") - Number(b.level !== "fail"));
  const build = view.steps.find((r) => r.key === "build");
  return (
    <div class="agents">
      <h2>Agents</h2>
      <p class="muted">Which agent each step runs as, and what it may use. Lists add up: all steps, then the stage's skills, then the step's own.</p>
      {p.failed && <p class="muted">The latest read of the agents failed; this may be out of date.</p>}
      {problems.length > 0 && (
        <div class={`callout${problems.some((x) => x.level === "fail") ? " bad" : ""}`} role={problems.some((x) => x.level === "fail") ? "alert" : undefined}>
          <ul class="agent-problems">
            {problems.map((x, i) => <li key={i}><strong>{x.level === "fail" ? "Missing" : "Note"}</strong> {x.text}</li>)}
          </ul>
        </div>
      )}
      <div class="set-rows">
        <div class="set-row">
          <label for="agents-sources">Where steps find agents and skills</label>
          <select id="agents-sources" key={`sources-${p.rev}`} value={view.sources} disabled={p.locked}
            onChange={(e) => w.setting("agents.sources", e.currentTarget.value)}>
            <option value="all">the repo, this machine and plugins</option>
            <option value="repo">only the repo's .claude/</option>
          </select>
          {p.wait("agents.sources")}
        </div>
      </div>
      {view.steps.map((row) => <StepRow key={row.key} w={w} row={row} build={build} />)}
      <h2>Teams</h2>
      <Teams w={w} />
      <h2>Agents and skills</h2>
      <Library w={w} />
    </div>
  );
}

/** One row of the table: a step (or all steps) and its six fields. */
function StepRow({ w, row, build }: { w: Writes; row: AgentStepRow; build: AgentStepRow | undefined }) {
  const base = row.key === "all" ? "agents.all" : `agents.steps.${row.key}`;
  return (
    <div class="set-group agent-step">
      <div class="set-row set-head">
        <span><code>{row.key === "all" ? "all steps" : row.key}</code> <span class="muted">{row.what}</span></span>
        {row.readOnly && row.key !== "all" && <span class="chip">read-only</span>}
        {row.chat && <span class="chip">chat</span>}
      </div>
      <div class="agent-fields">
        {(["agent", ...LIST_FIELDS, "tools", "mcp_tools"] as Field[]).map((field) => {
          const path = `${base}.${field}`;
          const e = effective(row, field, build);
          const note = fromNote(e, row, field);
          const shown = Array.isArray(e.value) ? listText(e.value) : e.value ?? "none";
          const id = `ag-${row.key}-${field}`;
          return (
            <div key={field} class="agent-field">
              {LIST_FIELDS.includes(field) || row.continuesBuild && field === "agent"
                ? <span class="agent-field-name">{FIELD_LABELS[field]}</span>
                : <label class="agent-field-name" for={id}>{FIELD_LABELS[field]}</label>}
              {field === "agent" ? (
                row.continuesBuild
                  ? <span>{shown}</span>
                  : <AgentPicker w={w} id={id} row={row} path={path} />
              ) : field === "tools" || field === "mcp_tools" ? (
                <ToolsInput w={w} id={id} row={row} field={field} path={path} />
              ) : (
                <ListPicker w={w} id={id} label={`${FIELD_LABELS[field]} for ${row.key === "all" ? "all steps" : row.key}`} chosen={asList(row.own[field])}
                  choices={choicesFor(w.view, field, row.key)} onSave={(list, after) => w.setting(path, list, after)} />
              )}
              {note && <span class="muted">{field === "agent" && row.continuesBuild ? note : `${shown} (${note})`}</span>}
              {row.chat && (field === "tools" || field === "mcp_tools") && <span class="agent-warn">{CHAT_WARNING}</span>}
              {w.wait(path)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A step's own agent: one of the library's (not a built-in), or none to take all steps'. */
function AgentPicker({ w, id, row, path }: { w: Writes; id: string; row: AgentStepRow; path: string }) {
  const own = typeof row.own.agent === "string" ? row.own.agent : "";
  const choices = withChosen(choicesFor(w.view, "agent", row.key), own ? [own] : []);
  return (
    <select id={id} key={`${id}-${w.rev}`} value={own} disabled={w.locked}
      onChange={(e) => { const x = e.currentTarget.value; w.setting(path, x === "" ? null : x); }}>
      <option value="">{row.key === "all" || !row.fromAll.agent ? "none" : "all steps'"}</option>
      {choices.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  );
}

/** Tools or MCP tools, typed as a list with commas: sent on Enter or on leaving the field, when changed. */
function ToolsInput({ w, id, row, field, path }: { w: Writes; id: string; row: AgentStepRow; field: Field; path: string }) {
  const own = asList(row.own[field]);
  const send = (el: HTMLInputElement) => {
    const list = parseList(el.value);
    if (same(list, own)) return;
    w.setting(path, list);
  };
  const example = field === "tools" ? (row.readOnly ? "Read, Bash(bun test)" : "Bash(bun test), Edit") : "mcp__github";
  return (
    <input id={id} key={`${id}-${w.rev}`} type="text" defaultValue={own.join(", ")} placeholder={example} disabled={w.locked} autocomplete="off" spellcheck={false}
      onKeyDown={(e) => { if (e.key === "Enter") send(e.currentTarget); }}
      onBlur={(e) => send(e.currentTarget)} />
  );
}

/**
 * A list picked from checkboxes in a fold: its summary is the list as it stands, Save sends the whole
 * list (an empty one removes it). `atLeastOne`: a team's members, which cannot be empty.
 */
function ListPicker(p: { w: Writes; id: string; label: string; chosen: string[]; choices: string[]; onSave: (list: string[], after: (ok: boolean) => void) => void; atLeastOne?: boolean }) {
  return <ListPickerBody key={`${p.id}-${p.w.rev}`} {...p} />;
}

function ListPickerBody({ w, id, label, chosen, choices, onSave, atLeastOne }: Parameters<typeof ListPicker>[0]) {
  const [picked, setPicked] = useState<string[]>(chosen);
  const all = withChosen(choices, chosen);
  const changed = !same(picked, chosen);
  const toggle = (name: string, on: boolean) => {
    // Kept in the order offered, so a list saved again reads the same.
    const next = new Set(on ? [...picked, name] : picked.filter((x) => x !== name));
    setPicked(all.filter((x) => next.has(x)));
  };
  return (
    <details class="agent-pick">
      <summary id={id} aria-label={`${label}: ${listText(chosen)}`}>{listText(chosen)}</summary>
      <div class="agent-pick-box" role="group" aria-label={label}>
        {all.length === 0 && <span class="muted">Nothing to pick yet: add agents or skills below.</span>}
        {all.length > 0 && (
          <div class="agent-pick-list">
            {all.map((name) => (
              <label key={name} class="agent-check">
                <input type="checkbox" checked={picked.includes(name)} disabled={w.locked} onChange={(e) => toggle(name, e.currentTarget.checked)} />
                <span>{name}</span>
                {!choices.includes(name) && <span class="muted">(not offered)</span>}
              </label>
            ))}
          </div>
        )}
        {all.length > 0 && (
          <div class="control-form">
            <button type="button" class="btn primary" disabled={w.locked || !changed || (atLeastOne && !picked.length)}
              onClick={() => onSave(picked, () => {})}>Save</button>
            {atLeastOne && !picked.length && <span class="muted">A team needs at least one member.</span>}
          </div>
        )}
      </div>
    </details>
  );
}

/** The teams: their members and way, a new one, and Delete while no step names it. */
function Teams({ w }: { w: Writes }) {
  const members = choicesFor(w.view, "subagents", "all");
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const create = () => {
    const n = name.trim();
    if (!TEAM_NAME.test(n)) { toast("A team name is lowercase words joined by dashes, like reviewers or ui-team.", "bad"); return; }
    if (w.view.teams.some((t) => t.name === n)) { toast(`There is already a team called ${n}.`, "bad"); return; }
    w.setting(`agents.teams.${n}.members`, picked, (ok) => { if (ok) { setName(""); setPicked([]); } });
  };
  return (
    <>
      {w.view.teams.length === 0 && <p class="muted">No teams yet. A team is several agents a step hands work to together.</p>}
      {w.view.teams.map((t) => {
        const path = `agents.teams.${t.name}`;
        return (
          <div key={t.name} class="set-group">
            <div class="set-row set-head">
              <span><code>{t.name}</code> <span class="muted">{usedText(t.usedBy)}</span></span>
              <button type="button" class="btn danger" disabled={w.locked || t.usedBy.length > 0}
                title={t.usedBy.length ? `Used by ${t.usedBy.join(", ")}: take it off first.` : undefined}
                onClick={() => w.setting(path, null)}>Delete</button>
              {w.wait(path)}
            </div>
            <div class="set-row set-step">
              <span class="set-label">members</span>
              <ListPicker w={w} id={`team-${t.name}-members`} label={`members of ${t.name}`} chosen={t.members} choices={members} atLeastOne
                onSave={(list, after) => w.setting(`${path}.members`, list, after)} />
              {w.wait(`${path}.members`)}
            </div>
            <div class="set-row set-step">
              <label for={`team-${t.name}-way`}>way</label>
              <select id={`team-${t.name}-way`} key={`team-${t.name}-way-${w.rev}`} value={t.way} disabled={w.locked}
                onChange={(e) => w.setting(`${path}.way`, e.currentTarget.value)}>
                {w.view.ways.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              {w.wait(`${path}.way`)}
            </div>
          </div>
        );
      })}
      <details class="folded">
        <summary>New team</summary>
        <div class="control-form agent-form">
          <input type="text" aria-label="Team name" placeholder="reviewers" value={name} autocomplete="off" spellcheck={false} onInput={(e) => setName(e.currentTarget.value)} />
          <div class="agent-pick-box agent-pick-list" role="group" aria-label="Members of the new team">
            {members.length === 0 && <span class="muted">No agents to pick yet.</span>}
            {members.map((m) => (
              <label key={m} class="agent-check">
                <input type="checkbox" checked={picked.includes(m)} onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setPicked((was) => members.filter((x) => (x === m ? on : was.includes(x))));
                }} />
                <span>{m}</span>
              </label>
            ))}
          </div>
          <button type="button" class="btn primary" disabled={w.locked || !name.trim() || !picked.length} onClick={create}>Create team</button>
          {w.wait(`agents.teams.${name.trim()}.members`)}
        </div>
      </details>
    </>
  );
}

/** The library, grouped by where each item is, with its actions; then adding from a source, and a new agent. */
function Library({ w }: { w: Writes }) {
  const repoHas = (kind: LibraryItemView["kind"], name: string) => w.view.library.find((i) => i.kind === kind && i.from === "repo" && i.name === name);
  return (
    <>
      {(["repo", "personal", "plugin"] as const).map((from) => {
        const items = w.view.library.filter((i) => i.from === from);
        if (from !== "repo" && !items.length) return null;
        return (
          <div key={from} class="set-group">
            <div class="set-row set-head"><span>{FROM_TITLES[from]}</span></div>
            {from !== "repo" && w.view.sources === "repo" && <p class="muted agent-indent">The steps use only the repo's while sources is the repo: add one to the repo to use it.</p>}
            {from === "repo" && !items.length && <p class="muted agent-indent">None yet: add one from this machine, a plugin or a git repository, or write a new agent.</p>}
            {items.map((i) => <LibraryItem key={`${i.kind}:${i.name}`} w={w} item={i} inRepo={from === "repo" ? undefined : repoHas(i.kind, repoName(i.name))} />)}
          </div>
        );
      })}
      <FromSource w={w} repoHas={repoHas} />
      <NewAgent w={w} />
    </>
  );
}

/** One agent or skill: what it is, who uses it, and what can be done with it. `inRepo`: the repo's item of the same name, for an item elsewhere. */
function LibraryItem({ w, item, inRepo }: { w: Writes; item: LibraryItemView; inRepo: LibraryItemView | undefined }) {
  const [form, setForm] = useState<"edit" | "remove" | "replace" | null>(null);
  const key = `files:${item.kind}:${item.name}`;
  const used = item.usedBy.length > 0;
  const add = (replace: boolean) => {
    if (item.from === "repo") return;
    const op: AgentFilesOp = replace && inRepo
      ? { op: "copy", kind: item.kind, name: item.name, from: item.from, replace: true, base: inRepo.base }
      : { op: "copy", kind: item.kind, name: item.name, from: item.from };
    w.files(key, op, (ok) => { if (ok) setForm(null); });
  };
  return (
    <div class="agent-item agent-indent">
      <div class="set-row">
        <span class="chip">{item.kind}</span>
        <code class="agent-name">{item.name}</code>
        <span class="muted">{usedText(item.usedBy)}</span>
        {item.from !== "repo" && (
          inRepo
            ? <button type="button" class="btn" disabled={w.locked} onClick={() => setForm("replace")}>Replace the repo's</button>
            : <button type="button" class="btn" disabled={w.locked} onClick={() => add(false)}>Add to the repo</button>
        )}
        {item.from === "repo" && item.editable && item.text !== undefined && <button type="button" class="btn" disabled={w.locked} onClick={() => setForm(form === "edit" ? null : "edit")}>Edit</button>}
        {item.from === "repo" && (
          <button type="button" class="btn danger" disabled={w.locked || used} title={used ? `Used by ${item.usedBy.join(", ")}: take it off first.` : undefined}
            onClick={() => setForm("remove")}>Remove</button>
        )}
        {w.wait(key)}
      </div>
      {item.description && <p class="muted agent-desc">{item.description}</p>}
      {form === "replace" && (
        <div class="control-form" role="group" aria-label="Confirm replacing">
          <span>Replace the repo's {item.kind} {repoName(item.name)} with this one?</span>
          <button type="button" class="btn primary" disabled={w.locked} onClick={() => add(true)}>Replace it</button>
          <button type="button" class="btn" onClick={() => setForm(null)}>Cancel</button>
        </div>
      )}
      {form === "remove" && (
        <div class="control-form" role="group" aria-label="Confirm removing">
          <span>Remove the {item.kind} {item.name} from the repo?</span>
          <button type="button" class="btn danger" disabled={w.locked || used}
            onClick={() => w.files(key, { op: "remove", kind: item.kind, name: item.name, base: item.base }, (ok) => { if (ok) setForm(null); })}>Remove it</button>
          <button type="button" class="btn" onClick={() => setForm(null)}>Cancel</button>
        </div>
      )}
      {form === "edit" && item.text !== undefined && <EditAgent w={w} item={item} done={() => setForm(null)} />}
    </div>
  );
}

/** A repo agent's file, edited whole. */
function EditAgent({ w, item, done }: { w: Writes; item: LibraryItemView; done: () => void }) {
  const [text, setText] = useState(item.text ?? "");
  return (
    <div class="control-form agent-form">
      <textarea aria-label={`The file of ${item.name}`} value={text} spellcheck={false} onInput={(e) => setText(e.currentTarget.value)} />
      <button type="button" class="btn primary" disabled={w.locked || !text.trim() || text === item.text}
        onClick={() => w.files(`files:${item.kind}:${item.name}`, { op: "edit", name: item.name, text, base: item.base }, (ok) => { if (ok) done(); })}>Save</button>
      <button type="button" class="btn" onClick={done}>Cancel</button>
    </div>
  );
}

/** Adding agents or skills from a git repository or a folder: list what it holds, pick, add (one kind per request). */
function FromSource({ w, repoHas }: { w: Writes; repoHas: (kind: LibraryItemView["kind"], name: string) => LibraryItemView | undefined }) {
  const [url, setUrl] = useState("");
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<{ url: string; listed: SourceItems } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const look = async () => {
    const u = url.trim();
    if (!u) return;
    setLooking(true);
    const listed = await listSource(u);
    setLooking(false);
    setFound({ url: u, listed });
    setPicked([]);
  };
  const add = (kind: LibraryItemView["kind"], names: string[]) => {
    if (!found) return;
    const existing = names.filter((n) => repoHas(kind, n));
    // Replacing one names the version read of each, "absent" for one the repo does not have.
    const op: AgentFilesOp = existing.length
      ? { op: "fetch", url: found.url, kind, names, replace: true, base: Object.fromEntries(names.map((n) => [n, repoHas(kind, n)?.base ?? "absent"])) }
      : { op: "fetch", url: found.url, kind, names };
    w.files(`files:source:${kind}`, op, (ok) => { if (ok) setPicked((was) => was.filter((x) => !x.startsWith(`${kind}:`))); });
  };
  const items = found && "items" in found.listed ? found.listed.items : [];
  return (
    <details class="folded">
      <summary>Add from a git repository or folder</summary>
      <form class="control-form" onSubmit={(e) => { e.preventDefault(); void look(); }}>
        <input type="text" aria-label="Git repository or folder" placeholder="https://github.com/team/agents or /path/to/folder" value={url} autocomplete="off" spellcheck={false}
          onInput={(e) => setUrl(e.currentTarget.value)} />
        <button type="submit" class="btn" disabled={looking || !url.trim()}>{looking ? "Looking…" : "Look"}</button>
      </form>
      {found && "error" in found.listed && <p class="callout bad">{found.listed.error}</p>}
      {found && "items" in found.listed && !items.length && <p class="muted">There are no agents or skills in {found.url}.</p>}
      {(["agent", "skill"] as const).map((kind) => {
        const these = items.filter((i) => i.kind === kind);
        if (!these.length) return null;
        const names = these.filter((i) => picked.includes(`${kind}:${i.name}`)).map((i) => i.name);
        return (
          <div key={kind} class="set-group">
            {these.map((i) => (
              <label key={i.name} class="agent-check agent-source-item">
                <input type="checkbox" checked={picked.includes(`${kind}:${i.name}`)} disabled={w.locked}
                  onChange={(e) => { const on = e.currentTarget.checked; const k = `${kind}:${i.name}`; setPicked((was) => (on ? [...was, k] : was.filter((x) => x !== k))); }} />
                <span class="chip">{kind}</span>
                <code class="agent-name">{i.name}</code>
                {repoHas(kind, i.name) && <span class="muted">replaces the repo's</span>}
                {i.description && <span class="muted agent-desc">{i.description}</span>}
              </label>
            ))}
            <div class="control-form">
              <button type="button" class="btn primary" disabled={w.locked || !names.length} onClick={() => add(kind, names)}>
                Add {names.length || ""} {kind}{names.length === 1 ? "" : "s"}
              </button>
              {w.wait(`files:source:${kind}`)}
            </div>
          </div>
        );
      })}
    </details>
  );
}

/** A new agent in the repo: its name, what it is for, its role, its tools and model. */
function NewAgent({ w }: { w: Writes }) {
  const empty = { name: "", description: "", prompt: "", tools: "", model: "" };
  const [f, setF] = useState(empty);
  const put = (k: keyof typeof empty) => (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => { const value = e.currentTarget.value; setF((was) => ({ ...was, [k]: value })); };
  const create = () => {
    const op: AgentFilesOp = { op: "new", name: f.name.trim(), description: f.description.trim(), prompt: f.prompt, tools: parseList(f.tools), model: f.model.trim() || null };
    w.files("files:new", op, (ok) => { if (ok) setF(empty); });
  };
  return (
    <details class="folded">
      <summary>New agent</summary>
      <div class="agent-form">
        <label>Name <input type="text" placeholder="lead-reviewer" value={f.name} autocomplete="off" spellcheck={false} onInput={put("name")} /></label>
        <label>What it is for <input type="text" placeholder="Reviews changes for the team's conventions" value={f.description} onInput={put("description")} /></label>
        <label>Its role <textarea placeholder="You review code for…" value={f.prompt} onInput={put("prompt")} /></label>
        <label>Tools <input type="text" placeholder="Read, Grep, Bash(bun test) (empty: the step's)" value={f.tools} autocomplete="off" spellcheck={false} onInput={put("tools")} /></label>
        <label>Model <input type="text" placeholder="sonnet (empty: the step's)" value={f.model} autocomplete="off" spellcheck={false} onInput={put("model")} /></label>
        <div class="control-form">
          <button type="button" class="btn primary" disabled={w.locked || !f.name.trim() || !f.description.trim() || !f.prompt.trim()} onClick={create}>Create agent</button>
          {w.wait("files:new")}
        </div>
      </div>
    </details>
  );
}
