import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { keyLabel, onMac } from "../keys";
import { SHORTCUTS } from "../shortcuts";
import { helpOpen } from "../store";
import { useReturnFocus } from "./focus";

export function Help() {
  return helpOpen.value ? <HelpBox /> : null;
}

function HelpBox() {
  const box = useRef<HTMLDivElement>(null);
  useReturnFocus();
  // Focus moves into the dialog so the keys behind it are not read as if the page were still in front.
  useEffect(() => { box.current?.focus(); }, []);
  const close = () => { helpOpen.value = false; };
  return (
    <div class="overlay" onClick={close}>
      <div class="help" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Keys" onClick={(e) => e.stopPropagation()}>
        <b>Keys</b>
        <dl>
          {SHORTCUTS.map((s) => (
            <Fragment key={s.keys}>
              <dt><kbd>{keyLabel(s.keys, onMac)}</kbd></dt>
              <dd>{s.label}</dd>
            </Fragment>
          ))}
          <dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>Move through the inbox</dd>
          <dt><kbd>O</kbd></dt><dd>Open the inbox item you are on</dd>
          <dt><kbd>A</kbd></dt><dd>Approve the inbox item you are on</dd>
        </dl>
      </div>
    </div>
  );
}
