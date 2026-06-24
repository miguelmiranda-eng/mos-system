import React from "react";
import { BUILD_TAG } from "@/buildInfo";

// Catches render crashes so the user sees the actual error instead of a blank
// white screen — and can screenshot it. Without this, any thrown error in a
// child unmounts the whole tree and paints nothing.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // Surface in the console for remote debugging.
    console.error("[MOS] App crash:", error, info);
  }
  render() {
    if (this.state.error) {
      const e = this.state.error;
      return (
        <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, sans-serif", color: "#111827", background: "#ffffff", minHeight: "100vh", boxSizing: "border-box" }}>
          <h2 style={{ color: "#dc2626", margin: "0 0 6px" }}>Algo falló en la pantalla</h2>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 12px" }}>
            Toma una captura de este texto y mándala. (build <b>{BUILD_TAG}</b>)
          </p>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, lineHeight: 1.5, background: "#f4f4f5", padding: 12, borderRadius: 8, color: "#b91c1c", border: "1px solid #fecaca" }}>
            {String((e && (e.stack || e.message)) || e)}
          </pre>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            style={{ marginTop: 14, padding: "12px 18px", background: "#3d5bff", color: "#fff", border: "none", borderRadius: 10, fontWeight: 800, fontSize: 14 }}
          >
            Recargar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
