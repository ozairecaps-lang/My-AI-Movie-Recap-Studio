import React, { useState, useEffect } from 'react';
import { SidebarLayout, StudioNavTab } from './components/SidebarLayout';
import { DashboardView } from './components/DashboardView';
import { CreateRecapView } from './components/CreateRecapView';
import { ScriptStudioView } from './components/ScriptStudioView';
import { VoiceStudioView } from './components/VoiceStudioView';
import { ProjectStudioView } from './components/ProjectStudioView';
import { ExportCenterView } from './components/ExportCenterView';
import { ProcessingHistoryView } from './components/ProcessingHistoryView';
import { SettingsView } from './components/SettingsView';
import { Project, ProcessingMode } from '../server/types';

const TAB_BREADCRUMBS: Record<StudioNavTab, string> = {
  dashboard: 'ပင်မဒက်ရှ်ဘုတ် (Dashboard)',
  create: 'ပရောဂျက် အသစ် (Create Project)',
  script_studio: 'Script စတူဒီယို (Script Studio)',
  voice_studio: 'အသံ စတူဒီယို (Voice Studio)',
  video_editor: 'ဗီဒီယို တည်းဖြတ်စက် (Video Editor)',
  export_center: 'ထုတ်ယူရန် စင်တာ (Export Center)',
  history: 'လုပ်ငန်း မှတ်တမ်း (Project History)',
  settings: 'ဆက်တင် & AI Provider Settings',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<StudioNavTab>('dashboard');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [initialCreateMode, setInitialCreateMode] = useState<ProcessingMode>('recap');
  const [appNotice, setAppNotice] = useState<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [summary, setSummary] = useState({
    total: 0,
    completed: 0,
    processing: 0,
    failed: 0,
  });
  const [loadingDemo, setLoadingDemo] = useState(false);

  const [groqApiKey, setGroqApiKey] = useState<string>(() => {
    try {
      return localStorage.getItem('MYAI_GROQ_KEY') || '';
    } catch {
      return '';
    }
  });

  const handleSaveGroqApiKey = (key: string) => {
    setGroqApiKey(key);
    try {
      localStorage.setItem('MYAI_GROQ_KEY', key);
    } catch {}
  };

  const fetchProjects = async () => {
    try {
      const res = await fetch('/api/projects');
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
        if (data.summary) {
          setSummary(data.summary);
        }
      }
    } catch (err) {
      console.error('Failed to fetch projects:', err);
    }
  };

  useEffect(() => {
    fetchProjects();
    const timer = setInterval(fetchProjects, 4000);
    return () => clearInterval(timer);
  }, []);

  const handleSelectProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    setActiveTab('video_editor');
  };

  const handleNavigateToCreate = (mode: ProcessingMode = 'recap') => {
    setInitialCreateMode(mode);
    setActiveTab('create');
  };

  const handleCreateDemo = async (mode: ProcessingMode = 'recap') => {
    try {
      setLoadingDemo(true);
      setAppNotice(null);
      const res = await fetch('/api/projects/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) throw new Error('နမူနာ ဖန်တီးခြင်း မအောင်မြင်ပါ');
      const demoProj: Project = await res.json();
      await fetchProjects();
      setSelectedProjectId(demoProj.id);
      setActiveTab('video_editor');
    } catch (err: any) {
      setAppNotice(err.message || 'နမူနာ ဖန်တီးခြင်း မအောင်မြင်ပါ');
    } finally {
      setLoadingDemo(false);
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        if (selectedProjectId === projectId) {
          setSelectedProjectId(null);
        }
        await fetchProjects();
      }
    } catch (err) {
      console.error('Delete error:', err);
    }
  };

  const handleUploadSuccess = (newProject: Project) => {
    fetchProjects();
    setSelectedProjectId(newProject.id);
    setActiveTab('video_editor');
  };

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const breadcrumb =
    activeTab === 'video_editor' && selectedProject
      ? `${TAB_BREADCRUMBS.video_editor} / ${selectedProject.title}`
      : TAB_BREADCRUMBS[activeTab];

  return (
    <SidebarLayout
      activeTab={activeTab}
      breadcrumb={breadcrumb}
      onSelectTab={(tab) => setActiveTab(tab)}
      onCreateNew={() => handleNavigateToCreate('recap')}
    >
      {appNotice && (
        <div
          role="alert"
          className="mb-6 p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs flex items-center justify-between"
        >
          <span>{appNotice}</span>
          <button
            type="button"
            onClick={() => setAppNotice(null)}
            className="text-rose-300 hover:text-white cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {activeTab === 'dashboard' && (
        <DashboardView
          projects={projects}
          summary={summary}
          onNavigateToCreate={handleNavigateToCreate}
          onSelectProject={handleSelectProject}
          onDeleteProject={handleDeleteProject}
          onCreateDemo={handleCreateDemo}
          loadingDemo={loadingDemo}
        />
      )}

      {activeTab === 'create' && (
        <CreateRecapView
          initialMode={initialCreateMode}
          onUploadSuccess={handleUploadSuccess}
          onStartDemo={handleCreateDemo}
          loadingDemo={loadingDemo}
          groqApiKey={groqApiKey}
        />
      )}

      {activeTab === 'script_studio' && (
        <ScriptStudioView
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={(id) => setSelectedProjectId(id)}
          onOpenEditor={handleSelectProject}
          onRefreshProjects={fetchProjects}
        />
      )}

      {activeTab === 'voice_studio' && <VoiceStudioView />}

      {activeTab === 'video_editor' && (
        <ProjectStudioView
          projectId={selectedProjectId}
          projects={projects}
          onSelectProject={(id) => setSelectedProjectId(id)}
          onBack={() => {
            setActiveTab('dashboard');
            fetchProjects();
          }}
          groqApiKey={groqApiKey}
        />
      )}

      {activeTab === 'export_center' && (
        <ExportCenterView
          projects={projects}
          onOpenEditor={handleSelectProject}
          onRefreshProjects={fetchProjects}
        />
      )}

      {activeTab === 'history' && (
        <ProcessingHistoryView
          projects={projects}
          onSelectProject={handleSelectProject}
          onRefreshProjects={fetchProjects}
        />
      )}

      {activeTab === 'settings' && (
        <SettingsView
          groqApiKey={groqApiKey}
          onSaveGroqApiKey={handleSaveGroqApiKey}
        />
      )}
    </SidebarLayout>
  );
}
