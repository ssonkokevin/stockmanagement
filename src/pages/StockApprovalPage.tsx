import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

interface ApprovalResult {
  success: boolean;
  message: string;
}

export function StockApprovalPage() {
  // Get token from URL params
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<ApprovalResult | null>(null);
  const [email, setEmail] = useState('');
  const [user, setUser] = useState<any>(null);
  
  // Get current user
  useEffect(() => {
    const storedUser = localStorage.getItem('platform_user');
    if (storedUser) {
      setUser(JSON.parse(storedUser));
    }
  }, []);
  
  // Process the token on mount
  useEffect(() => {
    if (token) {
      processApproval();
    } else {
      setResult({ success: false, message: 'No token provided' });
      setLoading(false);
    }
  }, [token]);
  
  const processApproval = async () => {
    if (!token) return;
    
    try {
      // Validate and use token
      const { data: validation, error: validationError } = await supabase.rpc('validate_and_use_token', {
        p_token: token,
        p_approver_email: email || user?.email || 'approver@system.com'
      });
      
      if (validationError) throw validationError;
      
      const validationResult = validation?.[0];
      
      if (!validationResult?.success) {
        setResult({ 
          success: false, 
          message: validationResult?.message || 'Invalid token' 
        });
        setLoading(false);
        return;
      }
      
      const requestId = validationResult.request_id;
      const approverLevel = validationResult.approver_level;
      
      // Process approval based on level
      let approvalResult;
      
      if (approverLevel === 'LEVEL_1') {
        const { data, error } = await supabase.rpc('approve_level_1_with_token', {
          p_request_id: requestId,
          p_approver_id: user?.id || '00000000-0000-0000-0000-000000000000',
          p_approver_email: email || user?.email || 'approver@system.com'
        });
        
        if (error) throw error;
        approvalResult = data?.[0];
      } else if (approverLevel === 'LEVEL_2') {
        const { data, error } = await supabase.rpc('approve_level_2_with_token', {
          p_request_id: requestId,
          p_approver_id: user?.id || '00000000-0000-0000-0000-000000000000',
          p_approver_email: email || user?.email || 'approver@system.com'
        });
        
        if (error) throw error;
        approvalResult = data?.[0];
      }
      
      if (approvalResult?.success) {
        setResult({
          success: true,
          message: `✅ ${approverLevel === 'LEVEL_1' ? 'Level 1' : 'Level 2'} approval successful! ${approverLevel === 'LEVEL_2' ? 'Report has been generated.' : ''}`
        });
      } else {
        setResult({
          success: false,
          message: approvalResult?.message || 'Approval failed'
        });
      }
      
    } catch (error: any) {
      console.error('Approval error:', error);
      setResult({
        success: false,
        message: `Error: ${error.message}`
      });
    } finally {
      setLoading(false);
    }
  };
  
  const handleApprove = async () => {
    if (!email) {
      alert('Please enter your email address');
      return;
    }
    setLoading(true);
    await processApproval();
  };
  
  const handleGoToDashboard = () => {
    window.location.href = '/';
  };
  
  if (loading) {
    return (
      <div className="container mt-5">
        <div className="text-center">
          <div className="spinner-border text-primary" role="status">
            <span className="visually-hidden">Loading...</span>
          </div>
          <p className="mt-3">Processing your approval...</p>
        </div>
      </div>
    );
  }
  
  return (
    <div className="container mt-5">
      <div className="row justify-content-center">
        <div className="col-md-6">
          <div className="card shadow">
            <div className="card-header bg-primary text-white">
              <h4 className="mb-0">Stock Approval</h4>
            </div>
            <div className="card-body">
              {result ? (
                <>
                  <div className={`alert ${result.success ? 'alert-success' : 'alert-danger'}`}>
                    <h5>{result.success ? '✅ Success' : '❌ Failed'}</h5>
                    <p className="mb-0">{result.message}</p>
                  </div>
                  
                  {result.success && (
                    <div className="mt-3">
                      <p>The stock issuance request has been approved and the status has been updated.</p>
                      {result.message.includes('Level 2') && (
                        <div className="alert alert-info">
                          <strong>📊 Report Generated:</strong> A stock issuance report has been automatically created.
                        </div>
                      )}
                    </div>
                  )}
                  
                  <button 
                    className="btn btn-primary w-100 mt-3"
                    onClick={handleGoToDashboard}
                  >
                    Go to Dashboard
                  </button>
                </>
              ) : (
                <>
                  <p>Please enter your email to approve this stock request:</p>
                  
                  {!user && (
                    <div className="mb-3">
                      <label className="form-label">Your Email:</label>
                      <input
                        type="email"
                        className="form-control"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="Enter your email"
                      />
                      <small className="text-muted">
                        This must match the email that received the approval request.
                      </small>
                    </div>
                  )}
                  
                  <div className="d-grid gap-2">
                    <button 
                      className="btn btn-success"
                      onClick={handleApprove}
                      disabled={loading}
                    >
                      <i className="bi bi-check-circle me-2"></i>
                      Approve Stock Request
                    </button>
                    <button 
                      className="btn btn-outline-secondary"
                      onClick={handleGoToDashboard}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          
          <div className="mt-3 text-center text-muted">
            <small>
              🔒 Secure Token-Based Approval System<br/>
              Token expires after 24 hours • One-time use only
            </small>
          </div>
        </div>
      </div>
    </div>
  );
}
