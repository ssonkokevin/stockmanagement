import { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { TopHeader } from './TopHeader';

interface PageWrapperProps {
  children: ReactNode;
  title?: string;
  subtitle?: string;
}

export function PageWrapper({ children, title, subtitle }: PageWrapperProps) {
  return (
    <div className="flex min-h-screen" style={{ background: '#F0F4F8', fontFamily: 'Outfit, sans-serif' }}>
      <Sidebar />
      <div className="flex flex-col flex-1" style={{ marginLeft: 220 }}>
        <TopHeader title={title} subtitle={subtitle} />
        <main className="flex-1 p-6" style={{ marginTop: 64 }}>
          {children}
        </main>
      </div>
    </div>
  );
}
