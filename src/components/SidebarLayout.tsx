import React, { useState } from 'react';
import {
  LayoutDashboard,
  Plus,
  FileText,
  Volume2,
  Clapperboard,
  PackageCheck,
  History,
  Settings,
  Menu,
  X,
  Film,
  ChevronRight,
} from 'lucide-react';

export type StudioNavTab =
  | 'dashboard'
  | 'create'
  | 'script_studio'
  | 'voice_studio'
  | 'video_editor'
  | 'export_center'
  | 'history'
  | 'settings';

interface SidebarLayoutProps {
  activeTab: StudioNavTab;
  breadcrumb: string;
  onSelectTab: (tab: StudioNavTab) => void;
  onCreateNew: () => void;
  children: React.ReactNode;
}

const PRIMARY_NAV: Array<{ id: StudioNavTab; label: string; sub: string; icon: React.ReactNode }> = [
  { id: 'dashboard', label: 'ပင်မဒက်ရှ်ဘုတ်', sub: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: 'create', label: 'ပရောဂျက် အသစ်', sub: 'Create Project', icon: <Plus className="w-4 h-4" /> },
];

const SUPPORTING_TOOLS: Array<{ id: StudioNavTab; label: string; sub: string; icon: React.ReactNode }> = [
  { id: 'script_studio', label: 'Script စတူဒီယို', sub: 'Script Studio', icon: <FileText className="w-4 h-4" /> },
  { id: 'voice_studio', label: 'အသံ စတူဒီယို', sub: 'Voice Studio', icon: <Volume2 className="w-4 h-4" /> },
  { id: 'video_editor', label: 'ဗီဒီယို တည်းဖြတ်စက်', sub: 'Video Editor', icon: <Clapperboard className="w-4 h-4" /> },
  { id: 'export_center', label: 'ထုတ်ယူရန် စင်တာ', sub: 'Export Center', icon: <PackageCheck className="w-4 h-4" /> },
  { id: 'history', label: 'လုပ်ငန်း မှတ်တမ်း', sub: 'Project History', icon: <History className="w-4 h-4" /> },
  { id: 'settings', label: 'ဆက်တင် & AI', sub: 'AI & Settings', icon: <Settings className="w-4 h-4" /> },
];

export const SidebarLayout: React.FC<SidebarLayoutProps> = ({
  activeTab,
  breadcrumb,
  onSelectTab,
  onCreateNew,
  children,
}) => {
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleNavClick = (tab: StudioNavTab) => {
    onSelectTab(tab);
    setMobileOpen(false);
  };

  const renderNavList = (items: typeof PRIMARY_NAV) =>
    items.map((item) => {
      const isActive = activeTab === item.id;
      return (
        <button
          key={item.id}
          type="button"
          onClick={() => handleNavClick(item.id)}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors cursor-pointer ${
            isActive
              ? 'bg-gradient-to-r from-violet-600/20 to-blue-600/15 text-white border border-violet-500/35'
              : 'text-slate-400 hover:text-slate-100 hover:bg-white/[0.04] border border-transparent'
          }`}
        >
          <span className={isActive ? 'text-violet-400 shrink-0' : 'text-slate-400 shrink-0'}>
            {item.icon}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-tight truncate">{item.label}</p>
            <p className="text-[11px] text-slate-500 truncate">{item.sub}</p>
          </div>
        </button>
      );
    });

  return (
    <div className="min-h-screen bg-[#060913] text-slate-100 flex">
      {/* Desktop Sidebar (260px) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 border-r border-white/[0.08] bg-[#0B1020]/90 backdrop-blur-xl sticky top-0 h-screen">
        <div className="h-16 px-5 flex items-center gap-3 border-b border-white/[0.08]">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-600 to-blue-600 flex items-center justify-center shrink-0">
            <Film className="w-5 h-5 text-white" />
          </div>
          <span className="text-sm font-bold tracking-tight text-white truncate">
            My AI Movie Recap Studio
          </span>
        </div>

        <nav aria-label="Studio navigation" className="flex-1 overflow-y-auto px-3 py-5 space-y-6">
          <div className="space-y-1">
            <p className="px-3 pb-1.5 text-[11px] font-medium text-slate-500">ပင်မလုပ်ငန်းခွင်</p>
            {renderNavList(PRIMARY_NAV)}
          </div>

          <div className="space-y-1">
            <p className="px-3 pb-1.5 text-[11px] font-medium text-slate-500">စတူဒီယို ကိရိယာများ</p>
            {renderNavList(SUPPORTING_TOOLS)}
          </div>
        </nav>

        <div className="p-4 border-t border-white/[0.08]">
          <p className="text-[11px] text-slate-500">
            Subtitle · Recap · Dubbing Studio
          </p>
        </div>
      </aside>

      {/* Mobile Drawer Overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative z-10 w-72 max-w-[85vw] bg-[#0B1020] border-r border-white/10 flex flex-col h-full">
            <div className="h-16 px-4 flex items-center justify-between border-b border-white/[0.08]">
              <span className="text-sm font-bold text-white truncate">My AI Movie Recap Studio</span>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer"
                aria-label="Close navigation menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <nav aria-label="Mobile navigation" className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
              <div className="space-y-1">{renderNavList(PRIMARY_NAV)}</div>
              <div className="space-y-1">
                <p className="px-3 pb-1 text-[11px] font-medium text-slate-500">စတူဒီယို ကိရိယာများ</p>
                {renderNavList(SUPPORTING_TOOLS)}
              </div>
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Header */}
        <header className="sticky top-0 z-30 h-16 px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4 border-b border-white/[0.08] bg-[#060913]/85 backdrop-blur-xl">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 rounded-lg text-slate-300 hover:text-white hover:bg-white/5 cursor-pointer shrink-0"
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2 text-xs sm:text-sm min-w-0">
              <span className="text-slate-400 hidden sm:inline whitespace-nowrap shrink-0">
                My AI Movie Recap Studio
              </span>
              <ChevronRight className="w-4 h-4 text-slate-600 hidden sm:inline shrink-0" />
              <span className="font-semibold text-white truncate">{breadcrumb}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onCreateNew}
              className="inline-flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 text-white text-xs sm:text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4 shrink-0" />
              <span className="sm:hidden">အသစ်ဖန်တီး</span>
              <span className="hidden sm:inline">ပရောဂျက် အသစ်ဖန်တီးမည်</span>
            </button>
          </div>
        </header>

        {/* Viewport Container */}
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 sm:py-8 max-w-[1400px] w-full mx-auto">
          {children}
        </main>

        <footer className="border-t border-white/[0.06] px-4 sm:px-8 py-5 text-xs text-slate-500">
          <div className="max-w-[1400px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
            <p>© {new Date().getFullYear()} My AI Movie Recap Studio</p>
            <p className="text-slate-600">Subtitle · Recap · Single-Voice Dubbing Production Workspace</p>
          </div>
        </footer>
      </div>
    </div>
  );
};
