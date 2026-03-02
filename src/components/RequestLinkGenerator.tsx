import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { Distributor, Mvno } from '../types/simcard';

interface RequestLinkGeneratorProps {
  distributor: Distributor;
  mvnos: Mvno[];
  onClose: () => void;
  onLinkGenerated: (link: string) => void;
}

export function RequestLinkGenerator({ distributor, mvnos, onClose, onLinkGenerated }: RequestLinkGeneratorProps) {
  const [loading, setLoading] = useState(false);
  const [currentLink, setCurrentLink] = useState<string | null>(null);
  const [expiration, setExpiration] = useState(7); // days
  const [requestTarget, setRequestTarget] = useState<'stock_issuance' | 'stock_request'>(
    distributor.mvno_id ? 'stock_request' : 'stock_issuance'
  );

  useEffect(() => {
    // If distributor already has a valid token, show it
    if (distributor.request_token && distributor.request_token_expires) {
      const expires = new Date(distributor.request_token_expires);
      if (expires > new Date()) {
        generateLinkFromToken(distributor.request_token);
      }
    }
  }, [distributor]);

  const generateLinkFromToken = (token: string) => {
    const baseUrl = window.location.origin;
    const link = `${baseUrl}/request?token=${token}`;
    setCurrentLink(link);
  };

  const handleGenerateLink = async () => {
    try {
      setLoading(true);
      // Use client-side UUID generation
      const token = crypto.randomUUID();
      await saveToken(token);
    } catch (err) {
      console.error('Error generating link:', err);
      // Fallback - generate UUID manually
      const token = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
      await saveToken(token);
    }
  };

  const handleRegenerateLink = async () => {
    try {
      setLoading(true);
      // Use client-side UUID generation
      const token = crypto.randomUUID();
      await saveToken(token);
    } catch (err) {
      console.error('Error generating link:', err);
    }
  };

  const saveToken = async (token: string) => {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiration);

    const { error } = await supabase
      .from('distributors')
      .update({
        request_token: token,
        request_token_expires: expiresAt.toISOString(),
        request_target: requestTarget
      })
      .eq('id', distributor.id);

    if (error) {
      console.error('Error saving token:', error);
      return;
    }

    generateLinkFromToken(token);
    onLinkGenerated(`Token generated (${requestTarget === 'stock_issuance' ? 'Superadmin' : 'MVNO'}), expires ${expiresAt.toLocaleDateString()}`);
    setLoading(false);
  };

  const handleRevokeLink = async () => {
    try {
      setLoading(true);

      const { error } = await supabase
        .from('distributors')
        .update({
          request_token: null,
          request_token_expires: null
        })
        .eq('id', distributor.id);

      if (error) {
        console.error('Error revoking token:', error);
        return;
      }

      setCurrentLink(null);
    } catch (err) {
      console.error('Error revoking link:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyLink = () => {
    if (currentLink) {
      navigator.clipboard.writeText(currentLink);
      alert('Link copied to clipboard!');
    }
  };

  const handleSendEmail = async () => {
    if (!currentLink) return;

    try {
      setLoading(true);

      // Create notification for the distributor
      // In production, this would trigger an actual email
      const { error } = await supabase
        .from('notifications')
        .insert({
          user_id: null, // External - no user ID
          title: 'Stock Request Link',
          message: `Your stock request link has been generated. Please use this link to submit stock requests: ${currentLink}`,
          type: 'INFO'
        });

      if (error) {
        console.error('Error creating notification:', error);
      }

      alert('Email notification sent! (Demo: Check console for the link)');
      console.log('Stock Request Link:', currentLink);
    } catch (err) {
      console.error('Error sending email:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal d-block" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content card card-custom">
          <div className="modal-header card-header card-header-custom">
            <h5 className="modal-title">
              <i className="bi bi-link-45deg me-2"></i>
              Generate Stock Request Link
            </h5>
            <button 
              type="button" 
              className="btn-close btn-close-white"
              onClick={onClose}
            ></button>
          </div>
          <div className="modal-body">
            {/* Distributor Info */}
            <div className="alert alert-info mb-4">
              <div className="d-flex align-items-center">
                <i className="bi bi-person-badge me-2 fs-4"></i>
                <div>
                  <strong>{distributor.name}</strong>
                  <br/>
                  <small className="text-muted">
                    {distributor.mvno_id ? 
                      `MVNO: ${mvnos.find(m => m.id === distributor.mvno_id)?.name || 'Unknown'}` :
                      'No MVNO assigned'
                    }
                  </small>
                </div>
              </div>
            </div>

            {/* Request Target Selection */}
            <div className="mb-3">
              <label className="form-label fw-bold">
                <i className="bi bi-diagram-3 me-2"></i>
                Request Destination
              </label>
              <div className="alert alert-warning py-2">
                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="radio"
                    name="requestTarget"
                    id="targetSuperadmin"
                    value="stock_issuance"
                    checked={requestTarget === 'stock_issuance'}
                    onChange={() => setRequestTarget('stock_issuance')}
                  />
                  <label className="form-check-label" htmlFor="targetSuperadmin">
                    <strong>Stock Issuance Request</strong> - Goes to Superadmin (Hamilton)
                    <br/>
                    <small className="text-muted">Use this for direct distribution from Hamilton</small>
                  </label>
                </div>
                <div className="form-check mt-2">
                  <input
                    className="form-check-input"
                    type="radio"
                    name="requestTarget"
                    id="targetMvno"
                    value="stock_request"
                    checked={requestTarget === 'stock_request'}
                    onChange={() => setRequestTarget('stock_request')}
                  />
                  <label className="form-check-label" htmlFor="targetMvno">
                    <strong>Distributor Request</strong> - Goes to {distributor.mvno_id ? 'Assigned MVNO' : 'No MVNO (will go to Superadmin)'}
                    <br/>
                    <small className="text-muted">Use this for requests through an MVNO</small>
                  </label>
                </div>
              </div>
            </div>

            {currentLink ? (
              <>
                {/* Expiration Selection */}
                <div className="mb-3">
                  <label className="form-label fw-bold">Link Expiration</label>
                  <div className="d-flex gap-2">
                    <select
                      className="form-select form-select-custom"
                      value={expiration}
                      onChange={(e) => setExpiration(parseInt(e.target.value))}
                    >
                      <option value={1}>1 day</option>
                      <option value={3}>3 days</option>
                      <option value={7}>7 days</option>
                      <option value={14}>14 days</option>
                      <option value={30}>30 days</option>
                    </select>
                    <button
                      className="btn btn-accent"
                      onClick={handleRegenerateLink}
                      disabled={loading}
                      title="Refresh with new expiration"
                    >
                      <i className="bi bi-arrow-clockwise"></i> Refresh
                    </button>
                  </div>
                </div>

                {/* Current Link */}
                <div className="mb-3">
                  <label className="form-label fw-bold">Active Request Link</label>
                  <div className="input-group">
                    <input
                      type="text"
                      className="form-control"
                      value={currentLink}
                      readOnly
                    />
                    <button
                      className="btn btn-outline-secondary"
                      onClick={handleCopyLink}
                      title="Copy to clipboard"
                    >
                      <i className="bi bi-clipboard"></i>
                    </button>
                  </div>
                  <small className="text-muted">
                    Expires: {distributor.request_token_expires ? 
                      new Date(distributor.request_token_expires).toLocaleString() : 
                      'Unknown'
                    }
                  </small>
                </div>

                {/* Actions */}
                <div className="d-flex gap-2">
                  <button
                    className="btn btn-primary flex-grow-1"
                    onClick={handleSendEmail}
                    disabled={loading}
                  >
                    <i className="bi bi-envelope me-2"></i>
                    Send Link via Email
                  </button>
                  <button
                    className="btn btn-outline-danger"
                    onClick={handleRevokeLink}
                    disabled={loading}
                    title="Revoke link"
                  >
                    <i className="bi bi-x-circle"></i>
                  </button>
                </div>
              </>
            ) : (
              <>
                {/* Expiration Selection */}
                <div className="mb-3">
                  <label className="form-label fw-bold">Link Expiration</label>
                  <select
                    className="form-select form-select-custom"
                    value={expiration}
                    onChange={(e) => setExpiration(parseInt(e.target.value))}
                  >
                    <option value={1}>1 day</option>
                    <option value={3}>3 days</option>
                    <option value={7}>7 days</option>
                    <option value={14}>14 days</option>
                    <option value={30}>30 days</option>
                  </select>
                </div>

                {/* Generate Button */}
                <button
                  className="btn btn-accent w-100"
                  onClick={handleGenerateLink}
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <span className="spinner-border spinner-border-sm me-2" role="status"></span>
                      Generating...
                    </>
                  ) : (
                    <>
                      <i className="bi bi-plus-circle me-2"></i>
                      Generate New Link
                    </>
                  )}
                </button>
              </>
            )}
          </div>
          <div className="modal-footer">
            <button 
              type="button" 
              className="btn btn-outline-custom"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default RequestLinkGenerator;
