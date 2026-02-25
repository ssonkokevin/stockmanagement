import { useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

export interface ExportFilters {
  mvno_id?: string;
  distributor_id?: string;
  date_from?: string;
  date_to?: string;
}

export interface ExportOptions {
  format: 'csv' | 'excel';
  filename?: string;
}

// Current user role - in a real app, this would come from auth
// For now, we'll store in localStorage and allow setting
const USER_ROLE_KEY = 'simcard_user_role';
const USER_EMAIL_KEY = 'simcard_user_email';
const USER_ID_KEY = 'simcard_user_id';

export function useExport() {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get current user info
  const getUserInfo = useCallback(() => {
    return {
      role: localStorage.getItem(USER_ROLE_KEY) || 'EMPLOYEE',
      email: localStorage.getItem(USER_EMAIL_KEY) || 'unknown@local',
      id: localStorage.getItem(USER_ID_KEY) || null
    };
  }, []);

  // Set user role (for demo purposes)
  const setUserRole = useCallback((role: string, email: string = 'user@local', id: string = '') => {
    localStorage.setItem(USER_ROLE_KEY, role);
    localStorage.setItem(USER_EMAIL_KEY, email);
    if (id) localStorage.setItem(USER_ID_KEY, id);
  }, []);

  // Check if user can export
  const canExport = useCallback(() => {
    const { role } = getUserInfo();
    return role === 'ADMIN' || role === 'MANAGEMENT';
  }, [getUserInfo]);

  // Fetch export data from database
  const fetchExportData = useCallback(async (filters: ExportFilters) => {
    const { data, error } = await supabase.rpc('get_distribution_export', {
      p_mvno_id: filters.mvno_id || null,
      p_distributor_id: filters.distributor_id || null,
      p_date_from: filters.date_from || null,
      p_date_to: filters.date_to || null,
      p_limit: 50000, // Handle large datasets
      p_offset: 0
    });

    if (error) throw error;
    return data || [];
  }, []);

  // Log export action to audit
  const logExport = useCallback(async (
    filters: ExportFilters,
    recordCount: number,
    format: string
  ) => {
    const { role, email, id } = getUserInfo();
    
    await supabase.rpc('log_export_action', {
      p_action: `EXPORT_${format.toUpperCase()}`,
      p_user_id: id || null,
      p_user_email: email,
      p_user_role: role,
      p_filters: JSON.stringify(filters),
      p_record_count: recordCount
    });
  }, [getUserInfo]);

  // Convert data to CSV
  const convertToCSV = useCallback((data: any[]): string => {
    if (!data || data.length === 0) return '';
    
    const headers = Object.keys(data[0]);
    const csvRows = [
      headers.join(','),
      ...data.map(row => 
        headers.map(header => {
          const value = row[header];
          // Escape quotes and wrap in quotes if contains comma
          if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value || '';
        }).join(',')
      )
    ];
    
    return csvRows.join('\n');
  }, []);

  // Convert data to Excel XML format (simple version)
  const convertToExcel = useCallback((data: any[]): string => {
    if (!data || data.length === 0) return '';
    
    const headers = Object.keys(data[0]);
    
    let xml = '<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>';
    xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ';
    xml += 'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">';
    xml += '<Worksheet ss:Name="Distribution History"><Table>';
    
    // Header row
    xml += '<Row>';
    for (const header of headers) {
      xml += `<Cell><Data ss:Type="String">${header}</Data></Cell>`;
    }
    xml += '</Row>';
    
    // Data rows
    for (const row of data) {
      xml += '<Row>';
      for (const header of headers) {
        const value = row[header];
        const type = typeof value === 'number' ? 'Number' : 'String';
        xml += `<Cell><Data ss:Type="${type}">${value || ''}</Data></Cell>`;
      }
      xml += '</Row>';
    }
    
    xml += '</Table></Worksheet></Workbook>';
    return xml;
  }, []);

  // Main export function
  const exportData = useCallback(async (
    filters: ExportFilters,
    options: ExportOptions
  ): Promise<{ success: boolean; message: string; blob?: Blob }> => {
    // Check permission
    if (!canExport()) {
      return { success: false, message: 'Export is only available for Admin and Management roles' };
    }

    setExporting(true);
    setError(null);

    try {
      // Fetch data
      const data = await fetchExportData(filters);
      
      if (!data || data.length === 0) {
        return { success: false, message: 'No data found for the selected filters' };
      }

      // Convert to requested format
      let blob: Blob;
      let filename = options.filename || `distribution_export_${new Date().toISOString().split('T')[0]}`;

      if (options.format === 'csv') {
        const csv = convertToCSV(data);
        blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        filename += '.csv';
      } else {
        const excel = convertToExcel(data);
        blob = new Blob([excel], { type: 'application/vnd.ms-excel' });
        filename += '.xls';
      }

      // Log the export action
      await logExport(filters, data.length, options.format);

      return { success: true, message: `Exported ${data.length} records`, blob };
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to export data';
      setError(errorMessage);
      return { success: false, message: errorMessage };
    } finally {
      setExporting(false);
    }
  }, [canExport, fetchExportData, convertToCSV, convertToExcel, logExport]);

  // Download blob
  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, []);

  return {
    exporting,
    error,
    exportData,
    downloadBlob,
    canExport,
    setUserRole,
    getUserInfo
  };
}
