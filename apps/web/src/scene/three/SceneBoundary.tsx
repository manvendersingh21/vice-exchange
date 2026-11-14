import { Component, type ReactNode } from "react";

/** True when the browser can create a WebGL context. Cheap; safe to call before loading three.js. */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

interface Props { fallback: ReactNode; onError?: (error: unknown) => void; children: ReactNode }
interface State { failed: boolean }

/** Wrap the lazy 3D view with this: any render/load error or missing WebGL shows `fallback` (the 2D city) instead. */
export class SceneBoundary extends Component<Props, State> {
  state: State = { failed: !webglAvailable() };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(error: unknown): void {
    console.warn("[city3d] 3D view failed, falling back to 2D:", error);
    this.props.onError?.(error);
  }
  componentDidMount(): void {
    if (this.state.failed) this.props.onError?.(new Error("WebGL unavailable"));
  }
  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
