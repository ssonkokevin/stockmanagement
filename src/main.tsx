import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ExternalStockRequest } from "./pages/ExternalStockRequest";
import "./index.css";

function Router() {
  // Check if this is an external request form
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  const distributor = urlParams.get('distributor');
  
  // If there's a token or distributor param, show the external request form
  if (token || distributor) {
    return <ExternalStockRequest />;
  }
  
  // Otherwise, show the main app
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Router />
  </React.StrictMode>
);
