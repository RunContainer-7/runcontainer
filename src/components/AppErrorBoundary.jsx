import React from "react";

// The last line of defence for the window itself. React unmounts the whole tree when a
// component throws, which is what a "blank RunContainer" is: the interface was there and
// then it was not. This keeps a readable screen with the real error and a way back, so a
// fault in one panel can never cost the user the app. The message is logged as well, and
// the packaged app already forwards console output to runcontainer-console.log.
export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error("RunContainer hit an unexpected error:", error, info?.componentStack || "");
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-card">
          <h1>RunContainer hit an unexpected error</h1>
          <p>
            The window stopped drawing instead of closing on you. Your installed apps and their files
            are untouched. Reloading brings the interface back, and the details below are what to send
            if you report it.
          </p>
          <pre className="crash-detail">{String(error?.message || error)}</pre>
          <div className="crash-actions">
            <button type="button" className="settings-button" onClick={() => window.location.reload()}>
              Reload RunContainer
            </button>
          </div>
        </div>
      </div>
    );
  }
}
