import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import {
  getAllProjects,
  getProjectById,
  addProject,
  updateProject,
  deleteProject,
  runProjectPipeline,
  continueAfterScriptApproval,
  createDemoProject,
  appendProjectLog,
  cancelProjectJob,
  cleanupProjectTempFiles,
  getStorageStats,
  reconcileStaleJobsOnStartup,
} from './server/pipeline';
import {
  BURMESE_VOICES,
  generateVoicePreview,
  generateBurmeseNarration,
  generateBurmeseDubbingSegmentClips,
  isValidBurmeseVoiceId,
  validateDubbingVoiceId,
} from './server/tts';
import { getProviderConfig, saveProviderConfig } from './server/providers';
import { Project, ProjectSettings } from './server/types';
import {
  getGroqApiKey,
  saveGroqApiKey,
  maskApiKey,
  testGroqConnection,
  transcribeChineseAudio,
  ensureTestAudio,
} from './server/groq';
import {
  getVideoMetadata,
  renderFinalRecap,
  extractAudio,
  normalizeVideoToMp4,
  assembleDubbingVideoWithSilencePreserved,
} from './server/ffmpeg';
import {
  MAX_UPLOAD_BYTES,
  DUBBING_VOICE_OPTIONS,
  isValidDubbingVoiceId,
  resolveSingleDubbingVoice,
  applySingleDubbingVoiceToSegments,
} from './src/utils/editorMath';
import { normalizeDubbingSegmentsWithSilence } from './src/utils/dubbingTimeline';
import {
  SubtitleCue,
  generateSrtContent,
  generateAssContent,
} from './src/utils/subtitle';
import {
  sanitizeAutoBlurConfig,
  getAutoBlurRenderSignature,
} from './src/utils/autoBlur';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

const UPLOADS_DIR = path.resolve(__dirname, 'uploads', 'projects');
const PREVIEWS_DIR = path.resolve(__dirname, 'uploads', 'previews');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(PREVIEWS_DIR)) {
  fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
}

// Multer storage for video & audio uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const existingId = req.params.id || (req as any)._assignedProjectId || req.body?.projectId;
    const projectId =
      existingId || 'proj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const projDir = path.join(UPLOADS_DIR, projectId);
    if (!fs.existsSync(projDir)) {
      fs.mkdirSync(projDir, { recursive: true });
    }
    (req as any)._assignedProjectId = projectId;
    cb(null, projDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === 'bgm') {
      cb(null, `bgm${ext || '.mp3'}`);
    } else if (['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(ext)) {
      cb(null, 'audio' + ext);
    } else if (ext === '.mp4') {
      cb(null, 'video.mp4');
    } else {
      cb(null, `video_raw${ext || '.mp4'}`);
    }
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES }, // Strict 100 MB limit
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.mkv', '.webm', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext) || file.mimetype.startsWith('video/') || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('ထောက်ပံ့မထားသော ဖိုင်အမျိုးအစားဖြစ်ပါသည် (MP4, MOV, MKV, WebM နှင့် အသံဖိုင်များသာ လက်ခံပါသည်)'));
    }
  },
});

// ----------------------------------------------------------------------------
// API Endpoints
// ----------------------------------------------------------------------------

// System Health & Engine Status
app.get('/api/health', (req: Request, res: Response) => {
  const hasGeminiKey = !!process.env.GEMINI_API_KEY;
  const hasGroqKey = !!getGroqApiKey();
  const providers = getProviderConfig();

  res.json({
    status: 'ok',
    geminiConfigured: hasGeminiKey,
    groqConfigured: hasGroqKey,
    activeProviders: providers,
    ttsProvider: providers.ttsProvider,
    ttsReady: true,
    ffmpegInstalled: true,
    maxUploadMb: Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)),
    fontSupport: 'Noto Sans Myanmar / Padauk',
  });
});

// Real Storage & Processing Status
app.get('/api/storage', (req: Request, res: Response) => {
  try {
    const stats = getStorageStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Storage status check failed' });
  }
});

// AI & TTS Provider Settings
app.get('/api/providers', (req: Request, res: Response) => {
  res.json(getProviderConfig());
});

app.post('/api/providers', (req: Request, res: Response) => {
  try {
    const { ttsProvider, textProvider, defaultVoice, dubbingDefaultVoice, geminiTtsVoice } = req.body;
    if (defaultVoice && !isValidBurmeseVoiceId(defaultVoice)) {
      return res.status(400).json({ error: `Invalid defaultVoice: ${defaultVoice}` });
    }
    if (dubbingDefaultVoice && !isValidDubbingVoiceId(dubbingDefaultVoice)) {
      return res.status(400).json({
        error: `Invalid dubbingDefaultVoice: ${dubbingDefaultVoice} (allowed: ${DUBBING_VOICE_OPTIONS.map(
          (v) => v.id
        ).join(', ')})`,
      });
    }
    const saved = saveProviderConfig({
      ...(ttsProvider ? { ttsProvider } : {}),
      ...(textProvider ? { textProvider } : {}),
      ...(defaultVoice ? { defaultVoice } : {}),
      ...(dubbingDefaultVoice ? { dubbingDefaultVoice } : {}),
      ...(geminiTtsVoice ? { geminiTtsVoice } : {}),
    });
    res.json({ success: true, config: saved });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Provider settings invalid' });
  }
});

// Verify Groq Server Status (without exposing raw key)
app.get('/api/groq/verify', (req: Request, res: Response) => {
  const key = getGroqApiKey();
  res.json({
    isAvailable: !!key,
    maskedKey: key ? maskApiKey(key) : null,
    model: 'whisper-large-v3',
    language: 'zh',
  });
});

// Securely Save Groq API Key on Server
app.post('/api/groq/save-key', (req: Request, res: Response) => {
  const { apiKey } = req.body;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return res.status(400).json({ error: 'Groq API Key မပါဝင်ပါ' });
  }
  saveGroqApiKey(apiKey);
  res.json({
    success: true,
    maskedKey: maskApiKey(apiKey),
    message: 'Groq API Key ကို ဆာဗာတွင် လုံခြုံစွာ သိမ်းဆည်းပြီးပါပြီ',
  });
});

// Test Groq Whisper Connection with Real Short Chinese Audio
app.post('/api/groq/test-connection', async (req: Request, res: Response) => {
  try {
    const { groqApiKey } = req.body;
    const result = await testGroqConnection(groqApiKey);
    if (!result.success) {
      return res.status(result.status || 400).json(result);
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      model: 'whisper-large-v3',
      language: 'zh',
      text: '',
      duration: 0,
      segments: [],
      error: err.message || 'Groq Whisper ချိတ်ဆက်မှု မအောင်မြင်ပါ',
    });
  }
});

// Serve real short Chinese sample audio for connection test preview
app.get('/api/groq/sample-audio', async (req: Request, res: Response) => {
  const samplePath = await ensureTestAudio();
  if (fs.existsSync(samplePath)) {
    res.setHeader('Content-Type', 'audio/mpeg');
    fs.createReadStream(samplePath).pipe(res);
  } else {
    res.status(404).send('Sample audio not found');
  }
});

// Secure Server-Side Chinese Speech Transcription Endpoint
app.post('/api/transcribe-chinese', upload.single('media'), async (req: Request, res: Response) => {
  try {
    let audioPath = '';
    const customKey = req.body.groqApiKey;

    if (req.file) {
      const filePath = req.file.path;
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (['.mp4', '.mov', '.mkv', '.webm'].includes(ext) || req.file.mimetype.startsWith('video/')) {
        const extractedPath = path.join(path.dirname(filePath), 'extracted_audio.mp3');
        await extractAudio(filePath, extractedPath);
        audioPath = extractedPath;
      } else {
        audioPath = filePath;
      }
    } else if (req.body.projectId) {
      const proj = getProjectById(req.body.projectId);
      if (!proj) return res.status(404).json({ error: 'စီမံကိန်း ရှာမတွေ့ပါ' });
      const projDir = path.join(UPLOADS_DIR, proj.id);
      audioPath = path.join(projDir, 'audio.mp3');
      if (!fs.existsSync(audioPath)) {
        const videoPath = path.join(projDir, 'video.mp4');
        if (fs.existsSync(videoPath)) {
          await extractAudio(videoPath, audioPath);
        } else {
          return res.status(404).json({ error: 'အသံဖိုင် သို့မဟုတ် ဗီဒီယိုဖိုင် ရှာမတွေ့ပါ' });
        }
      }
    } else {
      return res.status(400).json({ error: 'စကားပြောမှတ်သားရန် မီဒီယာဖိုင် သို့မဟုတ် projectId ထည့်သွင်းပေးပါ' });
    }

    const result = await transcribeChineseAudio(audioPath, customKey);
    res.json({
      success: true,
      model: 'whisper-large-v3',
      language: 'zh',
      text: result.text,
      duration: result.duration,
      segments: result.segments,
      provider: result.provider,
    });
  } catch (err: any) {
    console.error('Transcription error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'တရုတ်စကားပြော မှတ်သားခြင်း မအောင်မြင်ပါ',
    });
  }
});

app.get('/api/test-gemini', async (req: Request, res: Response) => {
  try {
    const { getGeminiClient } = await import('./server/gemini');
    const ai = getGeminiClient();
    const candidateModels = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
    const results: any[] = [];
    let successfulModel = null;
    let responseText = null;

    for (const model of candidateModels) {
      try {
        const result = await ai.models.generateContent({
          model,
          contents: 'Reply with JSON: {"status": "ok", "message": "hello"}',
        });
        successfulModel = model;
        responseText = result.text;
        break;
      } catch (e: any) {
        results.push({ model, error: e.message });
      }
    }

    if (successfulModel) {
      res.json({ success: true, model: successfulModel, text: responseText, attempted: results });
    } else {
      res.status(500).json({ success: false, errors: results });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Available Burmese Voices
app.get('/api/voices', (req: Request, res: Response) => {
  res.json(BURMESE_VOICES);
});

// Preview Voice & Speaking Speed with selectable provider
app.post('/api/voices/preview', async (req: Request, res: Response) => {
  try {
    const { voiceId = 'my-MM-NilarNeural', rate = '1.00x', sampleText, provider } = req.body;
    const safeRate = String(rate).replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeProv = provider ? String(provider).replace(/[^a-z]/g, '') : 'auto';
    const textHash = sampleText ? `_${Buffer.from(sampleText).toString('hex').slice(0, 8)}` : '';
    const previewFile = path.join(PREVIEWS_DIR, `preview_${safeProv}_${voiceId}_${safeRate}${textHash}.mp3`);

    if (!fs.existsSync(previewFile)) {
      await generateVoicePreview(voiceId, rate, previewFile, sampleText, provider);
    }

    res.sendFile(previewFile);
  } catch (err: any) {
    console.error('Preview error:', err);
    res.status(500).json({ error: err.message || 'အသံစမ်းသပ်မှု မအောင်မြင်ပါ' });
  }
});

// Get Projects List & Summary
app.get('/api/projects', (req: Request, res: Response) => {
  const projects = getAllProjects();
  const summary = {
    total: projects.length,
    completed: projects.filter((p) => p.status === 'completed').length,
    processing: projects.filter((p) => p.status === 'processing' || p.status === 'waiting_approval').length,
    failed: projects.filter((p) => p.status === 'failed').length,
    cancelled: projects.filter((p) => p.status === 'cancelled').length,
  };
  res.json({ projects, summary });
});

// Create Project via File Upload (100 MB limit)
app.post('/api/projects/upload', upload.single('video'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'ဗီဒီယိုဖိုင် မပါဝင်ပါ (Please select a video file)' });
    }

    const mode = (req.body.mode as any) || 'recap';
    const providerCfg = getProviderConfig();

    const requestedDubbingVoice = req.body.dubbingVoice || req.body.ttsVoice;
    if (
      mode === 'dubbing' &&
      requestedDubbingVoice &&
      !isValidDubbingVoiceId(requestedDubbingVoice) &&
      requestedDubbingVoice !== 'my-MM-NilarNeural' &&
      requestedDubbingVoice !== 'my-MM-ThihaNeural'
    ) {
      try {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      } catch {}
      return res.status(400).json({
        error: `Dubbing Mode အတွက် မမှန်ကန်သော အသံ ID ဖြစ်ပါသည်: ${requestedDubbingVoice}`,
      });
    }
    if (mode === 'recap' && req.body.ttsVoice && !isValidBurmeseVoiceId(req.body.ttsVoice)) {
      try {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      } catch {}
      return res.status(400).json({
        error: `မမှန်ကန်သော အသံ ID ဖြစ်ပါသည်: ${req.body.ttsVoice}`,
      });
    }

    const projectId =
      (req as any)._assignedProjectId ||
      req.body?._assignedProjectId ||
      'proj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const projDir = path.dirname(req.file.path);
    const mp4Path = path.join(projDir, 'video.mp4');
    if (path.basename(req.file.path) !== 'video.mp4') {
      await normalizeVideoToMp4(req.file.path, mp4Path);
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
    }
    const videoPath = mp4Path;
    const meta = await getVideoMetadata(videoPath);

    const resolvedDubbingVoice =
      mode === 'dubbing'
        ? validateDubbingVoiceId(requestedDubbingVoice, providerCfg.dubbingDefaultVoice)
        : undefined;

    let incomingAutoBlur: any = {};
    if (req.body.autoBlur) {
      try {
        incomingAutoBlur =
          typeof req.body.autoBlur === 'string' ? JSON.parse(req.body.autoBlur) : req.body.autoBlur;
      } catch {}
    } else {
      if (req.body.autoBlurEnabled !== undefined) {
        incomingAutoBlur.enabled = req.body.autoBlurEnabled !== 'false';
      }
      if (req.body.autoBlurStrength !== undefined) {
        incomingAutoBlur.strength = Number(req.body.autoBlurStrength);
      }
      if (req.body.autoBlurStyle !== undefined) {
        incomingAutoBlur.style = req.body.autoBlurStyle;
      }
    }
    const autoBlurConfig = sanitizeAutoBlurConfig(incomingAutoBlur);

    const defaultSettings: ProjectSettings = {
      mode,
      recapLength: (req.body.recapLength as any) || 'medium',
      narrationStyle: (req.body.narrationStyle as any) || 'dramatic',
      ttsProvider:
        mode === 'dubbing' ? 'gemini' : (req.body.ttsProvider as any) || providerCfg.ttsProvider,
      ttsVoice:
        mode === 'dubbing'
          ? resolvedDubbingVoice!
          : req.body.ttsVoice || providerCfg.defaultVoice || 'my-MM-NilarNeural',
      ...(mode === 'dubbing' ? { dubbingVoice: resolvedDubbingVoice } : {}),
      speakingRate: req.body.speakingRate || '1.00x',
      originalAudioVolume: parseFloat(req.body.originalAudioVolume ?? (mode === 'subtitle' ? '1.0' : '0.15')),
      narrationVolume: parseFloat(req.body.narrationVolume ?? '1.0'),
      bgmVolume: parseFloat(req.body.bgmVolume ?? '0.2'),
      burnSubtitles: req.body.burnSubtitles !== 'false',
      fontSize: parseInt(req.body.fontSize ?? '18', 10),
      autoBlur: autoBlurConfig,
    };

    const newProject: Project = {
      id: projectId,
      title: req.body.title || req.file.originalname.replace(/\.[^/.]+$/, ''),
      originalFilename: req.file.originalname,
      fileSize: req.file.size,
      duration: meta.duration,
      videoWidth: meta.width,
      videoHeight: meta.height,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'uploaded',
      currentStep: 1,
      progress: 5,
      currentStepTitle: 'ဗီဒီယို အပ်လုဒ်တင်ပြီးပါပြီ',
      mode,
      settings: defaultSettings,
      autoBlur: {
        regions: [],
        config: autoBlurConfig,
      },
      logs: [
        {
          timestamp: new Date().toISOString(),
          step: 1,
          message: `ဗီဒီယိုဖိုင် "${req.file.originalname}" (${(req.file.size / 1024 / 1024).toFixed(
            1
          )} MB) တင်သွင်းပြီးပါပြီ [${mode.toUpperCase()} MODE]`,
          type: 'success',
        },
      ],
    };

    addProject(newProject);

    const customGroqKey = req.body.groqApiKey;
    runProjectPipeline(projectId, 2, customGroqKey).catch((err) =>
      console.error('Background pipeline error:', err)
    );

    res.json(newProject);
  } catch (err: any) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'ဗီဒီယို အပ်လုဒ်တင်ခြင်း မအောင်မြင်ပါ' });
  }
});

// Create Demo Sample Project
app.post('/api/projects/demo', async (req: Request, res: Response) => {
  try {
    const mode = (req.body.mode as any) || 'recap';
    const demoProject = await createDemoProject(mode);
    runProjectPipeline(demoProject.id, 2).catch((err) =>
      console.error('Demo background pipeline error:', err)
    );
    res.json(demoProject);
  } catch (err: any) {
    console.error('Demo creation error:', err);
    res.status(500).json({ error: err.message || 'နမူနာ ဖန်တီးခြင်း မအောင်မြင်ပါ' });
  }
});

// Get Project Details
app.get('/api/projects/:id', (req: Request, res: Response) => {
  const project = getProjectById(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'စီမံကိန်း ရှာမတွေ့ပါ (Project not found)' });
  }
  res.json(project);
});

// Delete Project
app.delete('/api/projects/:id', (req: Request, res: Response) => {
  const success = deleteProject(req.params.id);
  if (!success) {
    return res.status(404).json({ error: 'ဖျက်ရန် စီမံကိန်း ရှာမတွေ့ပါ' });
  }
  res.json({ success: true, message: 'စီမံကိန်းကို အောင်မြင်စွာ ဖျက်ပြီးပါပြီ' });
});

// Cancel Running Pipeline Job
app.post('/api/projects/:id/cancel', (req: Request, res: Response) => {
  const project = getProjectById(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'စီမံကိန်း ရှာမတွေ့ပါ' });
  }
  const cancelled = cancelProjectJob(project.id);
  res.json({ success: true, cancelled, project: getProjectById(project.id) });
});

// Clean up temporary files for project
app.post('/api/projects/:id/cleanup', (req: Request, res: Response) => {
  const project = getProjectById(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'စီမံကိန်း ရှာမတွေ့ပါ' });
  }
  const { freedBytes } = cleanupProjectTempFiles(project.id);
  res.json({ success: true, freedBytes, project: getProjectById(project.id) });
});

// Upload Background Music (BGM) track for Dubbing / Video Editor
app.post('/api/projects/:id/bgm', upload.single('bgm'), (req: Request, res: Response) => {
  const project = getProjectById(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'စီမံကိန်း ရှာမတွေ့ပါ' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'နောက်ခံတေးဂီတ ဖိုင် မပါဝင်ပါ' });
  }

  const updated = updateProject(project.id, {
    settings: {
      ...project.settings,
      bgmFilename: req.file.filename,
      bgmVolume: project.settings.bgmVolume ?? 0.2,
    },
  });
  appendProjectLog(project.id, 12, `နောက်ခံတေးဂီတ "${req.file.originalname}" ထည့်သွင်းပြီးပါပြီ`, 'info');
  res.json({ success: true, project: updated });
});

// Start/Resume Pipeline
app.post('/api/projects/:id/start', (req: Request, res: Response) => {
  const project = getProjectById(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'စီမံကိန်း ရှာမတွေ့ပါ' });
  }

  const { groqApiKey } = req.body;
  runProjectPipeline(project.id, project.currentStep, groqApiKey).catch((err) =>
    console.error('Pipeline error:', err)
  );

  res.json({ message: 'လုပ်ငန်းစတင် ဆောင်ရွက်နေပါသည်', project });
});

// Retry Failed or Cancelled Project Step
app.post('/api/projects/:id/retry', (req: Request, res: Response) => {
  const project = getProjectById(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'စီမံကိန်း ရှာမတွေ့ပါ' });
  }

  const groqKey = req.body?.groqApiKey;
  if (
    project.currentStep >= 10 &&
    (project.recapScript?.approved || project.dialogueScript?.approved)
  ) {
    continueAfterScriptApproval(project.id).catch((err) =>
      console.error('Post-approval retry error:', err)
    );
  } else {
    const hasScript = Boolean(project.recapScript || project.dialogueScript);
    const stepToRetry = hasScript
      ? Math.max(2, project.currentStep)
      : Math.min(Math.max(2, project.currentStep), 8);
    runProjectPipeline(project.id, stepToRetry, groqKey).catch((err) =>
      console.error('Pipeline retry error:', err)
    );
  }

  res.json({ message: 'လုပ်ငန်းကို ပြန်လည် စတင်နေပါသည်', project });
});

// Update Script, Dialogue Translations, or Global Dubbing Voice
app.put('/api/projects/:id/script', (req: Request, res: Response) => {
  const project = getProjectById(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'စီမံကိန်း ရှာမတွေ့ပါ' });
  }

  const { script, dialogueScript, settings } = req.body;
  if (!script && !dialogueScript && !settings) {
    return res.status(400).json({ error: 'ပြင်ဆင်ထားသော စာသား မပါဝင်ပါ' });
  }

  const mode = project.settings?.mode || project.mode || 'recap';
  const updates: Partial<Project> = {};
  if (script) updates.recapScript = script;

  if (mode === 'dubbing') {
    const incomingVoice = settings?.dubbingVoice ?? settings?.ttsVoice;
    if (
      incomingVoice !== undefined &&
      !isValidDubbingVoiceId(incomingVoice) &&
      incomingVoice !== 'my-MM-NilarNeural' &&
      incomingVoice !== 'my-MM-ThihaNeural'
    ) {
      return res.status(400).json({
        error: `Dubbing Mode အတွက် မမှန်ကန်သော အသံ ID ဖြစ်ပါသည်: ${incomingVoice}`,
      });
    }
    const providerCfg = getProviderConfig();
    const globalDubbingVoice = validateDubbingVoiceId(
      incomingVoice || project.settings.dubbingVoice || project.settings.ttsVoice,
      providerCfg.dubbingDefaultVoice
    );

    const nextSettings: ProjectSettings = {
      ...project.settings,
      ...(settings || {}),
      dubbingVoice: globalDubbingVoice,
      ttsVoice: globalDubbingVoice,
      ttsProvider: 'gemini',
    };
    delete nextSettings.characterVoices;
    updates.settings = nextSettings;

    const baseDialogue = dialogueScript || project.dialogueScript;
    if (baseDialogue) {
      const cleanedDialogue = { ...baseDialogue };
      delete cleanedDialogue.characterVoices;
      cleanedDialogue.segments = normalizeDubbingSegmentsWithSilence(
        applySingleDubbingVoiceToSegments(cleanedDialogue.segments || [], globalDubbingVoice),
        globalDubbingVoice
      );
      updates.dialogueScript = cleanedDialogue;
    }
  } else {
    if (settings?.ttsVoice && !isValidBurmeseVoiceId(settings.ttsVoice)) {
      return res.status(400).json({ error: `Invalid ttsVoice: ${settings.ttsVoice}` });
    }
    if (dialogueScript) updates.dialogueScript = dialogueScript;
    if (settings) updates.settings = { ...project.settings, ...settings };
  }

  const updated = updateProject(project.id, updates);
  appendProjectLog(project.id, 9, 'အသုံးပြုသူမှ ဇာတ်ညွှန်း သို့မဟုတ် အသံဆက်တင်ကို တည်းဖြတ်ပြင်ဆင်ခဲ့သည်', 'info');
  res.json(updated);
});

// Update Subtitles (Split / Merge / Timing / Text / Subtitle Position & Masking) and persist SRT + ASS
app.put('/api/projects/:id/subtitles', (req: Request, res: Response) => {
  const project = getProjectById(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'စီမံကိန်း ရှာမတွေ့ပါ' });
  }

  const { cues, subtitleStyle } = req.body as {
    cues?: SubtitleCue[];
    subtitleStyle?: any;
  };

  const projDir = path.join(UPLOADS_DIR, project.id);
  if (!fs.existsSync(projDir)) {
    fs.mkdirSync(projDir, { recursive: true });
  }

  const nextStyle = subtitleStyle
    ? { ...(project.settings.subtitleStyle || {}), ...subtitleStyle }
    : project.settings.subtitleStyle;

  let srtPath = project.subtitles?.srtPath || path.join(projDir, 'subtitles.srt');
  let assPath = project.subtitles?.assPath || path.join(projDir, 'subtitles.ass');
  let cuesCount = project.subtitles?.cuesCount || 0;

  if (Array.isArray(cues)) {
    const cleanCues = cues.map((c, idx) => ({
      id: idx + 1,
      startTime: Number(c.startTime) || 0,
      endTime: Math.max((Number(c.startTime) || 0) + 0.1, Number(c.endTime) || 1),
      text: String(c.text || ''),
    }));

    srtPath = path.join(projDir, 'subtitles.srt');
    assPath = path.join(projDir, 'subtitles.ass');
    fs.writeFileSync(srtPath, generateSrtContent(cleanCues), 'utf8');
    fs.writeFileSync(
      assPath,
      generateAssContent(
        cleanCues,
        project.videoWidth || 1280,
        project.videoHeight || 720,
        nextStyle
      ),
      'utf8'
    );
    cuesCount = cleanCues.length;
  }

  const updated = updateProject(project.id, {
    settings: {
      ...project.settings,
      ...(nextStyle ? { subtitleStyle: nextStyle } : {}),
    },
    subtitles: {
      srtPath,
      assPath,
      cuesCount,
    },
    export: project.export
      ? {
          ...project.export,
          srtPath,
          assPath,
        }
      : undefined,
  });

  appendProjectLog(project.id, 11, 'စာတန်း အချိန်ကိုက်မှုနှင့် တည်နေရာဆက်တင်ကို သိမ်းဆည်းပြီးပါပြီ', 'info');
  res.json(updated);
});

// Update Auto Blur Settings Only (toggle on/off, strength, style — no manual mask editing)
app.put('/api/projects/:id/auto-blur', (req: Request, res: Response) => {
  const project = getProjectById(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'စီမံကိန်း ရှာမတွေ့ပါ' });
  }

  const nextConfig = sanitizeAutoBlurConfig({
    ...(project.autoBlur?.config || project.settings.autoBlur || {}),
    ...(req.body || {}),
  });

  const updated = updateProject(project.id, {
    settings: {
      ...project.settings,
      autoBlur: nextConfig,
    },
    autoBlur: {
      regions: project.autoBlur?.regions || [],
      config: nextConfig,
      detectedAt: project.autoBlur?.detectedAt,
      renderedSignature: project.autoBlur?.renderedSignature,
    },
  });

  res.json(updated);
});

// Approve Script & Trigger Step 10-13
app.post('/api/projects/:id/approve', async (req: Request, res: Response) => {
  const project = getProjectById(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'စီမံကိန်း ရှာမတွေ့ပါ' });
  }

  const mode = project.settings?.mode || project.mode || 'recap';
  const incomingSettings = req.body?.settings;

  if (mode === 'dubbing') {
    const requestedVoice = incomingSettings?.dubbingVoice ?? incomingSettings?.ttsVoice;
    if (
      requestedVoice !== undefined &&
      !isValidDubbingVoiceId(requestedVoice) &&
      requestedVoice !== 'my-MM-NilarNeural' &&
      requestedVoice !== 'my-MM-ThihaNeural'
    ) {
      return res.status(400).json({
        error: `Dubbing Mode အတွက် မမှန်ကန်သော အသံ ID ဖြစ်ပါသည်: ${requestedVoice}`,
      });
    }
    const providerCfg = getProviderConfig();
    const globalDubbingVoice = validateDubbingVoiceId(
      requestedVoice || project.settings.dubbingVoice || project.settings.ttsVoice,
      providerCfg.dubbingDefaultVoice
    );
    project.settings = {
      ...project.settings,
      ...(incomingSettings || {}),
      dubbingVoice: globalDubbingVoice,
      ttsVoice: globalDubbingVoice,
      ttsProvider: 'gemini',
    };
    delete project.settings.characterVoices;
    if (project.dialogueScript) {
      delete project.dialogueScript.characterVoices;
      project.dialogueScript.segments = normalizeDubbingSegmentsWithSilence(
        applySingleDubbingVoiceToSegments(
          project.dialogueScript.segments || [],
          globalDubbingVoice
        ),
        globalDubbingVoice
      );
    }
  } else if (incomingSettings) {
    if (incomingSettings.ttsVoice && !isValidBurmeseVoiceId(incomingSettings.ttsVoice)) {
      return res.status(400).json({ error: `Invalid ttsVoice: ${incomingSettings.ttsVoice}` });
    }
    project.settings = { ...project.settings, ...incomingSettings };
  }

  if (project.recapScript) {
    project.recapScript.approved = true;
  }
  if (project.dialogueScript) {
    project.dialogueScript.approved = true;
  }

  const nextAutoBlurCfg = incomingSettings?.autoBlur
    ? sanitizeAutoBlurConfig({
        ...(project.autoBlur?.config || project.settings.autoBlur || {}),
        ...incomingSettings.autoBlur,
      })
    : sanitizeAutoBlurConfig(project.autoBlur?.config || project.settings.autoBlur);

  project.settings.autoBlur = nextAutoBlurCfg;

  const saved = updateProject(project.id, {
    recapScript: project.recapScript,
    dialogueScript: project.dialogueScript,
    settings: project.settings,
    autoBlur: {
      regions: project.autoBlur?.regions || [],
      config: nextAutoBlurCfg,
      detectedAt: project.autoBlur?.detectedAt,
      renderedSignature: project.autoBlur?.renderedSignature,
    },
  });

  appendProjectLog(project.id, 9, 'စာသားများကို အတည်ပြုပြီး ဗီဒီယို ဖန်တီးမှု စတင်ပါသည်', 'success');

  continueAfterScriptApproval(project.id).catch((err) =>
    console.error('Post approval error:', err)
  );

  res.json({ message: 'အတည်ပြုပြီးပါပြီ။ အသံနှင့် ဗီဒီယို ဖန်တီးနေပါသည်', project: saved || project });
});

// Re-render Final Video (Audio Mix, BGM, Speaking Speed, Character Voices, Subtitle Style/Blur/Mask)
app.post('/api/projects/:id/re-render', async (req: Request, res: Response) => {
  const project = getProjectById(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'စီမံကိန်း ရှာမတွေ့ပါ' });
  }

  const mode = project.settings.mode || 'recap';
  const projectDir = path.join(UPLOADS_DIR, project.id);
  const videoPath = path.join(projectDir, 'video.mp4');
  let narrationAudioPath = path.join(projectDir, mode === 'dubbing' ? 'dubbing.mp3' : 'narration.mp3');
  let srtPath = path.join(projectDir, 'subtitles.srt');
  let assPath = path.join(projectDir, 'subtitles.ass');
  const outputPath = path.join(projectDir, 'final_recap.mp4');

  const oldRate = project.settings.speakingRate;
  const oldVoice =
    mode === 'dubbing'
      ? project.settings.dubbingVoice || project.settings.ttsVoice
      : project.settings.ttsVoice;

  if (mode === 'dubbing') {
    const incomingVoice = req.body.settings?.dubbingVoice ?? req.body.settings?.ttsVoice;
    if (
      incomingVoice !== undefined &&
      !isValidDubbingVoiceId(incomingVoice) &&
      incomingVoice !== 'my-MM-NilarNeural' &&
      incomingVoice !== 'my-MM-ThihaNeural'
    ) {
      return res.status(400).json({
        error: `Dubbing Mode အတွက် မမှန်ကန်သော အသံ ID ဖြစ်ပါသည်: ${incomingVoice}`,
      });
    }
    const providerCfg = getProviderConfig();
    const globalDubbingVoice = validateDubbingVoiceId(
      incomingVoice || oldVoice,
      providerCfg.dubbingDefaultVoice
    );
    const mergedAutoBlur = req.body.settings?.autoBlur
      ? sanitizeAutoBlurConfig({
          ...(project.autoBlur?.config || project.settings.autoBlur || {}),
          ...req.body.settings.autoBlur,
        })
      : sanitizeAutoBlurConfig(project.autoBlur?.config || project.settings.autoBlur);

    project.settings = {
      ...project.settings,
      ...(req.body.settings || {}),
      dubbingVoice: globalDubbingVoice,
      ttsVoice: globalDubbingVoice,
      ttsProvider: 'gemini',
      autoBlur: mergedAutoBlur,
    };
    delete project.settings.characterVoices;
    if (project.dialogueScript) {
      delete project.dialogueScript.characterVoices;
      project.dialogueScript.segments = normalizeDubbingSegmentsWithSilence(
        applySingleDubbingVoiceToSegments(
          project.dialogueScript.segments || [],
          globalDubbingVoice
        ),
        globalDubbingVoice
      );
      updateProject(project.id, {
        settings: project.settings,
        dialogueScript: project.dialogueScript,
        autoBlur: {
          regions: project.autoBlur?.regions || [],
          config: mergedAutoBlur,
          detectedAt: project.autoBlur?.detectedAt,
          renderedSignature: project.autoBlur?.renderedSignature,
        },
      });
    } else {
      updateProject(project.id, {
        settings: project.settings,
        autoBlur: {
          regions: project.autoBlur?.regions || [],
          config: mergedAutoBlur,
          detectedAt: project.autoBlur?.detectedAt,
          renderedSignature: project.autoBlur?.renderedSignature,
        },
      });
    }
  } else if (req.body.settings) {
    if (req.body.settings.ttsVoice && !isValidBurmeseVoiceId(req.body.settings.ttsVoice)) {
      return res.status(400).json({ error: `Invalid ttsVoice: ${req.body.settings.ttsVoice}` });
    }
    const mergedAutoBlur = req.body.settings?.autoBlur
      ? sanitizeAutoBlurConfig({
          ...(project.autoBlur?.config || project.settings.autoBlur || {}),
          ...req.body.settings.autoBlur,
        })
      : sanitizeAutoBlurConfig(project.autoBlur?.config || project.settings.autoBlur);

    project.settings = {
      ...project.settings,
      ...req.body.settings,
      autoBlur: mergedAutoBlur,
    };
    updateProject(project.id, {
      settings: project.settings,
      autoBlur: {
        regions: project.autoBlur?.regions || [],
        config: mergedAutoBlur,
        detectedAt: project.autoBlur?.detectedAt,
        renderedSignature: project.autoBlur?.renderedSignature,
      },
    });
  }

  const bgmAudioPath = project.settings.bgmFilename
    ? path.join(projectDir, project.settings.bgmFilename)
    : undefined;

  try {
    const rateChanged = req.body.settings?.speakingRate && req.body.settings.speakingRate !== oldRate;
    const nextVoice =
      mode === 'dubbing'
        ? resolveSingleDubbingVoice(project.settings.dubbingVoice || project.settings.ttsVoice)
        : project.settings.ttsVoice;
    const voiceChanged = nextVoice !== oldVoice;

    if (mode === 'dubbing' && project.dialogueScript) {
      updateProject(project.id, {
        status: 'processing',
        currentStep: 10,
        progress: 85,
        currentStepTitle: `အသံ (${nextVoice}) · အမြန်နှုန်း (${project.settings.speakingRate}) ဖြင့် Speaking/Silence Dubbing ကို အသစ်ပေါင်းစပ်နေပါသည်...`,
      });

      const { timelineItems, providerUsed, voiceUsed } = await generateBurmeseDubbingSegmentClips({
        segments: project.dialogueScript.segments,
        voiceId: nextVoice,
        rate: project.settings.speakingRate,
        outputDir: projectDir,
      });

      updateProject(project.id, {
        status: 'processing',
        currentStep: 12,
        progress: 92,
        currentStepTitle: 'FFmpeg ဖြင့် Speaking ဗီဒီယိုအပိုင်းများကိုသာ ညှိ၍ Silence (1.0x) နှင့် ပြန်လည်ပေါင်းစပ်နေပါသည်...',
      });

      const latestAutoBlurCfg = sanitizeAutoBlurConfig(
        project.settings.autoBlur || project.autoBlur?.config
      );
      const latestAutoBlurRegions = project.autoBlur?.regions || [];

      const assembled = await assembleDubbingVideoWithSilencePreserved({
        videoPath,
        segments: timelineItems,
        outputPath,
        combinedAudioOutputPath: narrationAudioPath,
        srtOutputPath: srtPath,
        assOutputPath: assPath,
        bgmAudioPath,
        originalAudioVolume: project.settings.originalAudioVolume,
        narrationVolume: project.settings.narrationVolume ?? 1.0,
        bgmVolume: project.settings.bgmVolume ?? 0.2,
        burnSubtitles: project.settings.burnSubtitles,
        subtitleStyle: project.settings.subtitleStyle,
        autoBlur: {
          regions: latestAutoBlurRegions,
          config: latestAutoBlurCfg,
        },
      });

      const timingById = new Map(assembled.segmentTimings.map((t) => [t.id, t]));
      const updatedSegments = project.dialogueScript.segments.map((seg, idx) => {
        const timing = timingById.get(seg.id) || assembled.segmentTimings[idx];
        if (!timing) return seg;
        return {
          ...seg,
          videoSpeedFactor: timing.videoSpeedFactor,
          outputStart: timing.outputStart,
          outputEnd: timing.outputEnd,
          ...(timing.ttsDuration !== undefined ? { ttsDuration: timing.ttsDuration } : {}),
        };
      });

      updateProject(project.id, {
        status: 'completed',
        error: null,
        currentStep: 13,
        progress: 100,
        currentStepTitle: 'ပြီးစီးပါပြီ! Silence 1.0x ထိန်းသိမ်း၍ Dubbing ဗီဒီယို အသစ်ဖန်တီးပြီးပါပြီ',
        dialogueScript: {
          ...project.dialogueScript,
          segments: updatedSegments,
        },
        narration: {
          audioPath: assembled.audioPath,
          durationSeconds: assembled.totalDuration,
          voiceUsed,
          providerUsed,
        },
        subtitles: {
          srtPath: assembled.srtPath,
          assPath: assembled.assPath,
          cuesCount: assembled.cues.length,
        },
        autoBlur: {
          regions: latestAutoBlurRegions,
          config: latestAutoBlurCfg,
          detectedAt: project.autoBlur?.detectedAt,
          renderedSignature: getAutoBlurRenderSignature(
            latestAutoBlurCfg,
            latestAutoBlurRegions.length
          ),
        },
        export: {
          videoPath: outputPath,
          srtPath: assembled.srtPath,
          assPath: assembled.assPath,
          scriptPath: path.join(projectDir, 'dialogue_script.txt'),
          renderedAt: new Date().toISOString(),
        },
      });

      return res.json({ success: true, project: getProjectById(project.id) });
    }

    if (mode === 'subtitle') {
      narrationAudioPath = '';
    } else if (
      mode === 'recap' &&
      (rateChanged || voiceChanged || req.body.regenerateNarration) &&
      project.recapScript
    ) {
      updateProject(project.id, {
        status: 'processing',
        currentStep: 10,
        progress: 85,
        currentStepTitle: `အသံအမြန်နှုန်း (${project.settings.speakingRate}) ဖြင့် မြန်မာအသံနှင့် စာတန်းများကို အသစ်ဖန်တီးနေပါသည်...`,
      });

      const {
        audioPath,
        srtPath: newSrt,
        assPath: newAss,
        totalDuration,
        cues,
        providerUsed,
      } = await generateBurmeseNarration({
        segments: project.recapScript.narrationSegments,
        voiceId: project.settings.ttsVoice,
        provider: project.settings.ttsProvider,
        rate: project.settings.speakingRate,
        outputDir: projectDir,
        videoWidth: project.videoWidth || 1280,
        videoHeight: project.videoHeight || 720,
        subtitleStyle: project.settings.subtitleStyle,
      });

      narrationAudioPath = audioPath;
      srtPath = newSrt;
      assPath = newAss;

      updateProject(project.id, {
        narration: {
          audioPath,
          durationSeconds: totalDuration,
          voiceUsed: project.settings.ttsVoice,
          providerUsed,
        },
        subtitles: {
          srtPath: newSrt,
          assPath: newAss,
          cuesCount: cues.length,
        },
      });
    }

    updateProject(project.id, {
      status: 'processing',
      currentStep: 12,
      progress: 92,
      currentStepTitle: 'FFmpeg ဖြင့် ဗီဒီယိုကို အသစ်ပြန်လည် ပေါင်းစပ်တည်းဖြတ်နေပါသည်...',
    });

    const latestAutoBlurCfg = sanitizeAutoBlurConfig(
      project.settings.autoBlur || project.autoBlur?.config
    );
    const latestAutoBlurRegions = project.autoBlur?.regions || [];

    const renderRes = await renderFinalRecap({
      videoPath,
      narrationAudioPath,
      bgmAudioPath,
      srtPath,
      outputPath,
      originalAudioVolume: project.settings.originalAudioVolume,
      narrationVolume: project.settings.narrationVolume ?? 1.0,
      bgmVolume: project.settings.bgmVolume ?? 0.2,
      burnSubtitles: project.settings.burnSubtitles,
      subtitleStyle: project.settings.subtitleStyle,
      autoBlur: {
        regions: latestAutoBlurRegions,
        config: latestAutoBlurCfg,
      },
    });
    if (renderRes.assPath) assPath = renderRes.assPath;

    updateProject(project.id, {
      status: 'completed',
      error: null,
      currentStep: 13,
      progress: 100,
      currentStepTitle: 'ပြီးစီးပါပြီ! အသစ်ပြန်လည် တည်းဖြတ်ပြီးပါပြီ',
      autoBlur: {
        regions: latestAutoBlurRegions,
        config: latestAutoBlurCfg,
        detectedAt: project.autoBlur?.detectedAt,
        renderedSignature: getAutoBlurRenderSignature(
          latestAutoBlurCfg,
          latestAutoBlurRegions.length
        ),
      },
      subtitles: {
        srtPath,
        assPath,
        cuesCount: project.subtitles?.cuesCount || 0,
      },
      export: {
        videoPath: outputPath,
        srtPath,
        assPath,
        scriptPath: path.join(projectDir, mode === 'recap' ? 'recap_script.txt' : 'dialogue_script.txt'),
        renderedAt: new Date().toISOString(),
      },
    });

    res.json({ success: true, project: getProjectById(project.id) });
  } catch (err: any) {
    console.error('Re-render error:', err);
    res.status(500).json({ error: err.message || 'ဗီဒီယို ပြန်လည်တည်းဖြတ်ခြင်း မအောင်မြင်ပါ' });
  }
});

// File Streaming & Downloads (Video, Audio, SRT, ASS, Script) with HTTP Range support
app.get('/api/files/:projectId/:filename', (req: Request, res: Response) => {
  const { projectId, filename } = req.params;
  const safeFilename = path.basename(filename);
  const filePath = path.join(UPLOADS_DIR, projectId, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('ဖိုင် ရှာမတွေ့ပါ (File not found)');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (safeFilename.endsWith('.mp4') && range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    let contentType = 'application/octet-stream';
    if (safeFilename.endsWith('.mp4')) contentType = 'video/mp4';
    else if (safeFilename.endsWith('.mp3')) contentType = 'audio/mpeg';
    else if (safeFilename.endsWith('.wav')) contentType = 'audio/wav';
    else if (
      safeFilename.endsWith('.srt') ||
      safeFilename.endsWith('.ass') ||
      safeFilename.endsWith('.txt')
    ) {
      contentType = 'text/plain; charset=utf-8';
    }

    const download = req.query.download === '1';
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    }

    res.setHeader('Content-Type', contentType);
    fs.createReadStream(filePath).pipe(res);
  }
});

// Clean Multer / Express Error Handler returning JSON (including 413 for >100 MB)
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'ဖိုင်အရွယ်အစားသည် အများဆုံး ကန့်သတ်ချက် 100 MB ထက် ကျော်လွန်နေပါသည်',
    });
  }
  res.status(err?.status || 400).json({
    error: err?.message || 'တောင်းဆိုမှု မအောင်မြင်ပါ',
  });
});

// ----------------------------------------------------------------------------
// Vite Middleware / Static Serving & WebSocket Server
// ----------------------------------------------------------------------------
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  const { createServer: createHttpServer } = await import('http');
  const { WebSocketServer } = await import('ws');
  const { handleLiveWebSocket } = await import('./server/liveSession');

  const server = createHttpServer(app);
  const wss = new WebSocketServer({ server, path: '/api/live' });

  wss.on('connection', (ws) => {
    handleLiveWebSocket(ws);
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const reconciled = reconcileStaleJobsOnStartup();
  if (reconciled > 0) {
    console.log(`[Startup] Reconciled ${reconciled} stale processing project(s) for Retry.`);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[My AI Movie Recap Studio] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
});
