import axios from 'axios';

export interface LoginResponse {
  token: string;
  user: any;
}

const AUTH_BASE =
  (import.meta.env.VITE_AUTH_BASE_URL as string | undefined) ||
  'http://localhost:3001/api';

export async function login(email: string, password: string): Promise<LoginResponse> {
  const resp = await axios.post(
    `${AUTH_BASE}/auth/login`,
    { email, password },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return resp?.data?.data as LoginResponse;
}

