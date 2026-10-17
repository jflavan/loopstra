import { Fragment } from "preact";
import { SHORTCUTS } from "../shortcuts";
import { helpOpen } from "../store";

const keyLabel = (keys: string) => keys.replace("mod+", "Ctrl ").replace("escape", "Esc").toUpperCase();

export function Help() {
  if (!helpOpen.value) return null;
  const close = () => { helpOpen.value = false; };
  return (
    <div class="overlay" onClick={close}>
      <div class="help" role="dialog" aria-label="Keys" onClick={(e) => e.stopPropagation()}>
        <b>Keys</b>
        <dl>
          {SHORTCUTS.map((s) => (
            <Fragment key={s.keys}>
              <dt><kbd>{keyLabel(s.keys)}</kbd></dt>
              <dd>{s.label}</dd>
            </Fragment>
          ))}
          <dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>Move through the inbox</dd>
          <dt><kbd>O</kbd></dt><dd>Open the inbox item you are on</dd>
        </dl>
      </div>
    </div>
  );
}
