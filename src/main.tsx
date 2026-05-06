import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

const normalizedPath = window.location.pathname.replace(/\/+$/, "") || "/";
const RootPage = lazy(() => (normalizedPath === "/map" ? import("./MapPage") : import("./App")));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<div className="app-loading">Loading tokens.loans…</div>}>
      <RootPage />
    </Suspense>
  </React.StrictMode>,
);
