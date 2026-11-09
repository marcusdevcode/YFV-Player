import { Component, type ReactNode } from "react";

/** If something in the page crashes, show what happened instead of an empty black window. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, color: "#fff", fontFamily: "system-ui, sans-serif" }}>
        <h2>Something went wrong</h2>
        <pre style={{ whiteSpace: "pre-wrap", color: "#ff9a9a" }}>{String(this.state.error.stack ?? this.state.error)}</pre>
      </div>
    );
  }
}
