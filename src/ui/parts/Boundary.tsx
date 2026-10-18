import { Component, type ComponentChildren } from "preact";
import { toast } from "../store";
import { Link } from "./Link";

interface Props {
  /** What is inside, named for the person ("this screen", "the orchestrator's drawer"). */
  name: string;
  /** What is drawn instead once the inside failed; without one, a short explanation with Try again. */
  fallback?: ComponentChildren;
  children?: ComponentChildren;
}

/**
 * Catches an error thrown while drawing what is inside, so one broken part does not take the whole
 * console down (Preact would otherwise unmount everything and leave a blank page). The error goes
 * to the browser's console. With no `fallback` the part is replaced by a few words and Try again;
 * with one, that is drawn and a toast says what failed.
 */
export class Boundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  override componentDidCatch(e: unknown): void {
    console.error(`loopstra: ${this.props.name} could not be drawn`, e);
    if (this.props.fallback !== undefined) toast(`${capital(this.props.name)} could not be drawn. The browser's console says why.`, "bad");
    this.setState({ failed: true });
  }

  override render(): ComponentChildren {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <section class="view">
        <h1>Something went wrong</h1>
        <p class="muted">
          {capital(this.props.name)} could not be drawn; the browser's console says why.{" "}
          <button class="link" type="button" onClick={() => this.setState({ failed: false })}>Try again</button>, or <Link href="/">go to Live</Link>.
        </p>
      </section>
    );
  }
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
