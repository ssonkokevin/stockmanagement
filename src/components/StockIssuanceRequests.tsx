import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { StockIssuanceRequest, Mvno, SimType } from '../types/simcard';
import { StockStatus } from '../types/simcard';

interface User { id: string; email: string; role: string; }

const canApproveLevel1 = (request: StockIssuanceRequest, user: User | null): boolean => {
  if (!user) return false;
  return request.status === StockStatus.READY_FOR_APPROVAL && user.role === 'MANAGEMENT';
};

const canApproveLevel2 = (request: StockIssuanceRequest, user: User | null): boolean => {
  if (!user) return false;
  return request.status === StockStatus.LEVEL_1_APPROVED && user.role === 'SUPER_ADMIN';
};

const canIssueStock = (request: StockIssuanceRequest, user: User | null): boolean => {
  if (!user) return false;
  return request.status === StockStatus.LEVEL_2_APPROVED && user.role === 'SUPER_ADMIN';
};

const canAssignStock = (request: StockIssuanceRequest, user: User | null): boolean => {
  if (!user) return false;
  return (user.role === 'MANAGEMENT' || user.role === 'SUPER_ADMIN') && (
    request.status === StockStatus.PENDING || request.status === StockStatus.READY_FOR_APPROVAL ||
    request.status === StockStatus.LEVEL_1_APPROVED || request.status === StockStatus.LEVEL_2_APPROVED
  );
};

interface BoxInfo { boxId: string; cartonNumber: string; boxNumber: number; boxDisplay: string; remainingSims: number; iccidStart: string; iccidEnd: string; selectedQty?: number; }
interface Carton { id: string; carton_number: string; mvno_id: string; }
interface EsimItem { id: number; iccid: string; imsi: string; status: string; }

export function StockIssuanceRequests({ mvnoId, showAll = false }: { mvnoId?: string; showAll?: boolean }) {
  const [requests, setRequests] = useState<StockIssuanceRequest[]>([]);
  const [mvnos, setMvnos] = useState<Mvno[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<StockIssuanceRequest | null>(null);
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [actionType, setActionType] = useState<'approve'|'reject'>('approve');
  const [approvalNotes, setApprovalNotes] = useState('');
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [availableBoxes, setAvailableBoxes] = useState<BoxInfo[]>([]);
  const [loadingBoxes, setLoadingBoxes] = useState(false);
  const [cartons, setCartons] = useState<{cartonId: string;cartonNumber:string;boxes:BoxInfo[];totalSims:number;selectedSims:number}[]>([]);
  const [reviewSimType, setReviewSimType] = useState<'ESIM'|'PHYSICAL'>('PHYSICAL');
  const [reviewMvnoId, setReviewMvnoId] = useState<string>('');
  const [reviewCartons, setReviewCartons] = useState<Carton[]>([]);
  const [esimSearch, setEsimSearch] = useState<string>('');
  const [availableEsims, setAvailableEsims] = useState<EsimItem[]>([]);
  const [selectedEsims, setSelectedEsims] = useState<EsimItem[]>([]);
  const [esimsLoading, setEsimsLoading] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [pendingApprovalRequest, setPendingApprovalRequest] = useState<StockIssuanceRequest|null>(null);
  const [emailSending, setEmailSending] = useState(false);
  const [formData, setFormData] = useState({ mvno_id: mvnoId||'', sim_type:'PHYSICAL' as SimType, quantity:100, notes:'', level_1_approver_email:'kssonkokevin@gmail.com', level_2_approver_email:'bombten09@gmail.com' });

  useEffect(() => { loadData(); }, [mvnoId, showAll]);
  useEffect(() => { const u=localStorage.getItem('platform_user'); if(u) setCurrentUser(JSON.parse(u)); }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const {data:mvnosData}=await supabase.from('mvnos').select('*').order('name');
      if(mvnosData) setMvnos(mvnosData);
      let query = supabase.from('stock_issuance_requests').select('*').order('created_at',{ascending:false});
      if(!showAll && mvnoId) query=query.eq('mvno_id',mvnoId);
      const {data:requestsData}=await query.limit(50);
      if(requestsData){
        const withDist=await Promise.all(requestsData.map(async(r:any)=>{
          let dn=null; if(r.requester_id){ const{data:d}=await supabase.from('distributors').select('name').eq('id',r.requester_id).single(); dn=d?.name;}
          return{...r,distributor_name:dn};
        }));
        setRequests(withDist);
      }
    }catch(e){console.error(e);}finally{setLoading(false);}
  };

  const openReviewModal=async(r:StockIssuanceRequest)=>{setSelectedRequest(r);setReviewSimType(r.sim_type==='ESIM'?'ESIM':'PHYSICAL');setReviewMvnoId(r.mvno_id||'');setSelectedEsims([]);setEsimSearch('');if(r.mvno_id&&r.sim_type!=='ESIM'){const{data}=await supabase.from('cartons').select('id,carton_number,mvno_id').eq('mvno_id',r.mvno_id).order('carton_number');setReviewCartons(data||[]);const{data:cartonsData}=await supabase.from('cartons').select('id').eq('mvno_id',r.mvno_id);const cid=(cartonsData||[]).map((c:any)=>c.id)||[];if(cid.length){const{data:bxs}=await supabase.from('boxes').select('id,box_number,remaining_sims,iccid_start,iccid_end,cartons(carton_number,mvno_id)').in('carton_id',cid).gt('remaining_sims',0).order('box_number');if(bxs){const bxm=bxs.map((b:any)=>({boxId:b.id,cartonNumber:b.cartons?.carton_number||'Unknown',boxNumber:b.box_number,boxDisplay:b.box_display||`Box ${b.box_number}`,remainingSims:b.remaining_sims||0,iccidStart:b.iccid_start||'',iccidEnd:b.iccid_end||'',selectedQty:0}));setAvailableBoxes(bxm);}}}
      setShowReviewModal(true);}
  
  const searchReviewEsims=async()=>{if(!reviewMvnoId||esimSearch.length<3)return;setEsimsLoading(true);try{const{data:mv}=await supabase.from('mvnos').select('name').eq('id',reviewMvnoId).single();const op=mv?.name||'';const{data,error}=await supabase.from('esim_stock').select('id,iccid,imsi,status').eq('operator',op).in('status',['IN_STOCK','available','IN_STORE','AVAILABLE']).ilike('iccid',`%${esimSearch}%`).limit(50);if(error)throw error;setAvailableEsims(data||[]);}catch(e){console.error(e);}finally{setEsimsLoading(false);}}
  useEffect(()=>{if(reviewMvnoId&&reviewSimType==='ESIM'&&esimSearch.length>=3)searchReviewEsims();},[esimSearch,reviewMvnoId,reviewSimType]);

  const handleBoxQtyChange=(boxId:string,q:number)=>setAvailableBoxes(bs=>bs.map(b=>b.boxId===boxId?{...b,selectedQty:Math.min(Math.max(0,q),b.remainingSims)}:b));
  const handleSelectAllBoxes=()=>setAvailableBoxes(bs=>bs.map(b=>({...b,selectedQty:b.remainingSims})));
  const handleClearAllBoxes=()=>setAvailableBoxes(bs=>bs.map(b=>({...b,selectedQty:0})));
  const toggleReviewEsimSelection=(e:EsimItem)=>setSelectedEsims(prev=>prev.find(x=>x.iccid===e.iccid)?prev.filter(x=>x.iccid!==e.iccid):[...prev,e]);
  const getSelectedSimCount=()=>reviewSimType==='ESIM'?selectedEsims.length:availableBoxes.reduce((s,b)=>s+(b.selectedQty||0),0);

  const handleAssignBoxes=async()=>{if(!selectedRequest)return;try{setSubmitting(true);const ud:any={sim_type:reviewSimType==='ESIM'?'ESIM':'PHYSICAL',mvno_id:reviewMvnoId,status:StockStatus.READY_FOR_APPROVAL};if(reviewSimType==='ESIM'){ud.assigned_esim_iccids=selectedEsims.map(e=>e.iccid);}else{const bq=availableBoxes.filter(b=>(b.selectedQty||0)>0).map(b=>({box_id:b.boxId,quantity:b.selectedQty,iccid_start:b.iccidStart,iccid_end:b.iccidEnd}));ud.assigned_box_ids=bq.map(b=>b.box_id);ud.assigned_box_quantities=bq;}
    const{error}=await supabase.from('stock_issuance_requests').update(ud).eq('id',selectedRequest.id);if(error)throw error;alert('Assigned! Status: READY_FOR_APPROVAL');setShowReviewModal(false);loadData();}catch(e:any){console.error(e);alert('Error: '+e.message);}finally{setSubmitting(false);}}

  const sendApprovalNotification=async(rid:string,mvnoName:string,qty:number,simType:string,cs:string,ns:string)=>{try{const{data:r}=await supabase.from('stock_issuance_requests').select('level_1_approver_email,level_2_approver_email').eq('id',rid).single();if(!r)return;let te:string[]=[];let nt='';if(cs==='PENDING'&&r.level_1_approver_email){te=[r.level_1_approver_email];nt='Ready for L1';}else if(cs==='LEVEL_1_APPROVED'&&r.level_2_approver_email){te=[r.level_2_approver_email];nt='Ready for L2';}
    if(te.length){await supabase.from('notifications').insert({type:'STOCK_REQUEST_APPROVAL',title:nt,message:`Request for ${qty} ${simType} SIMs for ${mvnoName} ready.`,related_id:rid,target_emails:te});}}catch(e){console.error(e);}}

  const openApprovalModal=(r:StockIssuanceRequest,a:'approve'|'reject')=>{setSelectedRequest(r);setActionType(a);setApprovalNotes('');setShowApprovalModal(true);}
  const handleApprove=async()=>{if(!selectedRequest)return;try{setSubmitting(true);const u=localStorage.getItem('platform_user');const user=u?JSON.parse(u):null;if(!user){alert('Login required');return;}
    let ns=StockStatus.LEVEL_1_APPROVED;let uf:any={status:ns,notes:approvalNotes||null};
    if(selectedRequest.status===StockStatus.PENDING){ns=StockStatus.LEVEL_1_APPROVED;uf={status:ns,level_1_approver_id:user.id,level_1_approved_at:new Date().toISOString(),notes:approvalNotes||null};}else if(selectedRequest.status===StockStatus.LEVEL_1_APPROVED){if(user.role!=='MANAGEMENT'&&user.role!=='SUPER_ADMIN'){alert('Only MANAGEMENT/SUPER_ADMIN L2');setSubmitting(false);return;}
      ns=StockStatus.LEVEL_2_APPROVED;uf={status:ns,level_2_approver_id:user.id,level_2_approved_at:new Date().toISOString(),notes:approvalNotes||null};}else if(selectedRequest.status===StockStatus.LEVEL_2_APPROVED){if(user.role!=='SUPER_ADMIN'){alert('Only SUPER_ADMIN');setSubmitting(false);return;}
      ns=StockStatus.STOCK_ISSUED;uf={status:ns,completed_at:new Date().toISOString(),notes:approvalNotes||null};}else{alert('Invalid');setSubmitting(false);return;}
    const{error}=await supabase.from('stock_issuance_requests').update(uf).eq('id',selectedRequest.id);if(error)throw error;alert('Approved!');setShowApprovalModal(false);loadData();}catch(e:any){alert('Error: '+e.message);}finally{setSubmitting(false);}}
  const handleReject=async()=>{if(!selectedRequest)return;try{setSubmitting(true);const{error}=await supabase.from('stock_issuance_requests').update({status:'REJECTED',rejection_reason:approvalNotes}).eq('id',selectedRequest.id);if(error)throw error;alert('Rejected!');setShowApprovalModal(false);loadData();}catch(e:any){alert('Error: '+e.message);}finally{setSubmitting(false);}}

  const sendForApproval=async(r:StockIssuanceRequest)=>{try{setSubmitting(true);const hb=(r as any).assigned_box_ids?.length>0;const he=(r as any).assigned_esim_iccids?.length>0;if(!hb&&!he){alert('Assign stock first');return;}
    const{error:ue}=await supabase.from('stock_issuance_requests').update({status:StockStatus.READY_FOR_APPROVAL,sent_for_approval_at:new Date().toISOString()}).eq('id',r.id);if(ue){alert('Error: '+ue.message);return;}
    alert('✅ Sent for approval! Status: READY_FOR_APPROVAL');loadData();}catch(e:any){alert('Error: '+e.message);}finally{setSubmitting(false);}}
  const handleSendApprovalEmail=async()=>{if(!pendingApprovalRequest)return;try{setEmailSending(true);const isL1=pendingApprovalRequest.status===StockStatus.PENDING;const mv=mvnos.find(m=>m.id===pendingApprovalRequest.mvno_id);await sendApprovalNotification(pendingApprovalRequest.id,mv?.name||'Unknown',pendingApprovalRequest.quantity,pendingApprovalRequest.sim_type,pendingApprovalRequest.status,isL1?'LEVEL_1_APPROVED':'LEVEL_2_APPROVED');alert('Sent!');setShowEmailModal(false);loadData();}catch(e:any){alert('Error: '+e.message);}finally{setEmailSending(false);}}

  const getStatusBadge=(s:StockStatus|string|null|undefined)=>{if(!s)return<span className="badge bg-secondary">New</span>;switch(s){case StockStatus.PENDING:return<span className="badge"style={{backgroundColor:'#ffc107',color:'#000'}}>Pending</span>;case StockStatus.READY_FOR_APPROVAL:return<span className="badge"style={{backgroundColor:'#0d6efd',color:'#fff'}}>Ready</span>;case StockStatus.LEVEL_1_APPROVED:return<span className="badge"style={{backgroundColor:'#fd7e14',color:'#fff'}}>L1</span>;case StockStatus.LEVEL_2_APPROVED:return<span className="badge"style={{backgroundColor:'#6f42c1',color:'#fff'}}>L2</span>;case StockStatus.STOCK_ISSUED:return<span className="badge bg-success">Issued</span>;case StockStatus.REJECTED:return<span className="badge bg-danger">Rejected</span>;default:return<span className="badge bg-secondary">{s}</span>;}}
  const formatDate=(d:string)=>new Date(d).toLocaleString();

  if(loading)return<div className="text-center py-5"><div className="spinner-border"role="status"><span>Loading...</span></div></div>;

  return(<div className="stock-issuance-requests">
    <div className="d-flex justify-content-between align-items-center mb-4"><h4>Stock Issuance Requests</h4></div>
    {requests.length===0?(<div className="card card-custom"><div className="card-body text-center py-5">No requests</div></div>):(<div className="card card-custom"><div className="card-body p-0"><table className="table table-custom mb-0"><thead><tr><th>Date</th>{showAll&&<th>Requester</th>}<th>SIM</th><th className="text-end">Qty</th><th>Status</th><th>Actions</th></tr></thead><tbody>{requests.map(r=>(<tr key={r.id}><td><small>{formatDate(r.created_at)}</small></td>{showAll&&<td>{(r as any).distributor_name||mvnos.find(m=>m.id===r.mvno_id)?.name||'?'}</td>}<td>{r.sim_type}</td><td className="text-end fw-bold">{r.quantity}</td><td>{getStatusBadge(r.status)}</td><td><div className="d-flex gap-1">
    {canAssignStock(r,currentUser)&&<button className="btn btn-sm btn-outline-primary"onClick={()=>openReviewModal(r)}><i className="bi bi-box-seam"></i> Assign</button>}
    {(r.status===StockStatus.PENDING||r.status===StockStatus.READY_FOR_APPROVAL||r.status===StockStatus.LEVEL_1_APPROVED||r.status===StockStatus.LEVEL_2_APPROVED)&&<button className="btn btn-sm btn-danger"onClick={()=>openApprovalModal(r,'reject')}><i className="bi bi-x-lg"></i></button>}
  </div></td></tr>))}</tbody></table></div></div>)}
    {showApprovalModal&&selectedRequest&&(<div className="modal d-block"style={{backgroundColor:'rgba(0,0,0,0.7)'}}><div className="modal-dialog"><div className="modal-content card card-custom"><div className="modal-header card-header card-header-custom"><h5 className="modal-title">{actionType==='approve'?'Approve':'Reject'}</h5><button className="btn-close btn-close-white"onClick={()=>setShowApprovalModal(false)}></button></div><div className="modal-body"><p><strong>MVNO:</strong> {mvnos.find(m=>m.id===selectedRequest.mvno_id)?.name||'?'}<br/><strong>SIM:</strong> {selectedRequest.sim_type}<br/><strong>Qty:</strong> {selectedRequest.quantity}<br/><strong>Status:</strong> {getStatusBadge(selectedRequest.status)}</p><div className="mb-3"><label>Notes</label><textarea className="form-control"rows={3}value={approvalNotes}onChange={e=>setApprovalNotes(e.target.value)}/></div></div><div className="modal-footer"><button className="btn btn-secondary"onClick={()=>setShowApprovalModal(false)}>Cancel</button>{actionType==='approve'?<button className="btn btn-success"onClick={handleApprove}disabled={submitting}>{submitting?'...':'Confirm'}</button>:<button className="btn btn-danger"onClick={handleReject}disabled={submitting}>{submitting?'...':'Confirm'}</button>}</div></div></div></div>)}
    {showReviewModal&&selectedRequest&&(<div className="modal d-block"style={{backgroundColor:'rgba(0,0,0,0.7)',zIndex:1050}}><div className="modal-dialog modal-xl"><div className="modal-content card card-custom"><div className="modal-header card-header card-header-custom"><h5>Assign Stock</h5><button className="btn-close btn-close-white"onClick={()=>setShowReviewModal(false)}></button></div><div className="modal-body"><div className="alert alert-info">{selectedRequest.quantity} {selectedRequest.sim_type} SIMs for {mvnos.find(m=>m.id===selectedRequest.mvno_id)?.name}</div>
      <div className="mb-3"><label>MVNO</label><select className="form-select"value={reviewMvnoId}onChange={e=>{setReviewMvnoId(e.target.value);setReviewSimType('PHYSICAL');setSelectedEsims([]);}}><option value="">Select</option>{mvnos.map(m=><option key={m.id}value={m.id}>{m.name}</option>)}</select></div>
      <div className="mb-3"><label>Type</label><div className="btn-group w-100"><input type="radio"className="btn-check"name="rst"id="rstP"checked={reviewSimType==='PHYSICAL'}onChange={()=>{setReviewSimType('PHYSICAL');setSelectedEsims([]);}}/><label className="btn btn-outline-custom"htmlFor="rstP">Physical</label><input type="radio"className="btn-check"name="rst"id="rstE"checked={reviewSimType==='ESIM'}onChange={()=>{setReviewSimType('ESIM');setAvailableBoxes([]);}}/><label className="btn btn-outline-custom"htmlFor="rstE">eSIM</label></div></div>
      {reviewSimType==='PHYSICAL'&&(<div><div className="d-flex justify-content-between mb-2"><label>Boxes ({availableBoxes.reduce((s,b)=>s+b.remainingSims,0)} SIMs)</label><div><button className="btn btn-sm btn-outline-success me-1"onClick={handleSelectAllBoxes}>All</button><button className="btn btn-sm btn-outline-secondary"onClick={handleClearAllBoxes}>Clear</button></div></div>{loadingBoxes?<div className="text-center py-3"><div className="spinner-border"></div></div>:(<div className="table-responsive"style={{maxHeight:'300px'}}><table className="table table-sm"><thead><tr><th>Carton</th><th>Box</th><th>ICCID Start</th><th>ICCID End</th><th>Rem</th><th>Select</th></tr></thead><tbody>{availableBoxes.map(b=>(<tr key={b.boxId}><td><span className="badge bg-primary">{b.cartonNumber}</span></td><td>{b.boxDisplay}</td><td><small>{b.iccidStart}</small></td><td><small>{b.iccidEnd}</small></td><td><span className="badge bg-success">{b.remainingSims}</span></td><td><input type="number"className="form-control form-control-sm"style={{width:'80px'}}min="0"max={b.remainingSims}value={b.selectedQty||0}onChange={e=>handleBoxQtyChange(b.boxId,parseInt(e.target.value)||0)}/></td></tr>))}{availableBoxes.length===0&&<tr><td colSpan={6}className="text-center text-muted">No boxes</td></tr>}</tbody></table></div>)}</div>)}
      {reviewSimType==='ESIM'&&(<div><div className="mb-3"><input className="form-control"placeholder="Search ICCID..."value={esimSearch}onChange={e=>setEsimSearch(e.target.value)}/></div>{availableEsims.length>0&&(<div className="table-responsive"style={{maxHeight:'300px'}}><table className="table table-sm"><thead><tr><th>Select</th><th>ICCID</th><th>IMSI</th></tr></thead><tbody>{availableEsims.map(e=>(<tr key={e.id}className={selectedEsims.some(x=>x.iccid===e.iccid)?'table-success':''}><td><input type="checkbox"checked={selectedEsims.some(x=>x.iccid===e.iccid)}onChange={()=>toggleReviewEsimSelection(e)}/></td><td className="mono">{e.iccid}</td><td className="mono">{e.imsi}</td></tr>))}</tbody></table></div>)}<div className="alert alert-info">{selectedEsims.length} selected</div></div>)}
      <div className="alert alert-warning">Selected: {getSelectedSimCount()} | Requested: {selectedRequest.quantity}{getSelectedSimCount()<selectedRequest.quantity&&<span className="text-danger ms-2">(Insufficient)</span>}</div>
      <div className="modal-footer">
        <button className="btn btn-secondary"onClick={()=>setShowReviewModal(false)}>Cancel</button>
        <button className="btn btn-primary"onClick={handleAssignBoxes}disabled={submitting||getSelectedSimCount()<selectedRequest.quantity}>{submitting?'...':`Send for Approval (${getSelectedSimCount()})`}</button>
      </div>
    </div></div></div></div>)}
  </div>);
}
