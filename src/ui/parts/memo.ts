import { Component, h, type ComponentChild, type FunctionComponent } from "preact";

/**
 * Draws `Inner` again only when one of its props is a different value. This stands in for preact/compat's
 * memo, which would pull the whole compatibility layer (and its changes to how inputs fire events) into the page.
 */
export function memo<P extends object>(Inner: FunctionComponent<P>): FunctionComponent<P> {
  class Memo extends Component<P> {
    shouldComponentUpdate(next: P): boolean {
      const a = this.props as Record<string, unknown>;
      const b = next as Record<string, unknown>;
      const keys = Object.keys(b);
      return keys.length !== Object.keys(a).length || keys.some((k) => a[k] !== b[k]);
    }
    render(): ComponentChild {
      return h(Inner as FunctionComponent<P>, this.props);
    }
  }
  return Memo as unknown as FunctionComponent<P>;
}
