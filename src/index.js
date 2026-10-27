import React from "react";
import ReactDOM from "react-dom";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
import "./styles/index.css";

ReactDOM.render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
  document.getElementById("root")
);
