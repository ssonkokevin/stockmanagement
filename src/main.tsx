import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ExternalStockRequest } from "./pages/ExternalStockRequest";
import ApproveIssuance from "./pages/ApproveIssuance";
import { StockApprovalPage } from "./pages/StockApprovalPage";
import "./index.css";

function Router() {
  // Check if this is an external request form
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  const distributor = urlParams.get('distributor');
  const approvalId = urlParams.get('id');
  const approveType = urlParams.get('approveType');
  const path = window.location.pathname;
  
  // If path is /approve-stock or has token with approveType=stock, show stock approval
  if (path === '/approve-stock' || approveType === 'stock') {
    return <StockApprovalPage />;
  }
  
  // If there's an approval id, show the approval page
  if (approvalId) {
    return <ApproveIssuance />;
  }
  
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
