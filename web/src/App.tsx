import { useEffect, useMemo, useState } from 'react'
import { initPro, ProShell, useAuth } from '@proappstore/sdk'
import {
  BookOpen,
  CheckCircle2,
  Cloud,
  Copy,
  Download,
  FileText,
  Github,
  KeyRound,
  Loader2,
  PenLine,
  Rocket,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'

const app = initPro({ appId: 'freedocstore-editor' })
const DEFAULT_MODEL = 'gpt-4.1-mini'
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
const FDS_MCP = 'https://freedocstore-mcp.serge-the-dev.workers.dev/mcp'

type Mode = 'publish' | 'edit'
type StepState = 'idle' | 'busy' | 'ok' | 'error'

interface Settings {
  githubToken: string
  openaiKey: string
  openaiEndpoint: string
  model: string
  cloudflareAccountId: string
  cloudflareApiToken: string
}

interface PublishForm {
  title: string
  slug: string
  owner: string
  customDomain: string
  visibility: 'public' | 'private'
  prompt: string
}

interface EditForm {
  repo: string
  branch: string
  path: string
  instruction: string
}

interface RepoFile {
  path: string
  content: string
}

interface Proposal {
  summary: string
  rationale: string
  content: string
}

interface PublishStep {
  id: string
  label: string
  detail: string
  state: StepState
}

const emptySettings: Settings = {
  githubToken: '',
  openaiKey: '',
  openaiEndpoint: DEFAULT_ENDPOINT,
  model: DEFAULT_MODEL,
  cloudflareAccountId: '',
  cloudflareApiToken: '',
}

const starterPublish: PublishForm = {
  title: 'True Non-Profit',
  slug: 'true-non-profit',
  owner: 'FreeDocStore',
  customDomain: '',
  visibility: 'public',
  prompt:
    'A first-principles knowledge base about non-profits, what they should be, how to assess trueness, and how to maintain a public evidence register.',
}

const starterEdit: EditForm = {
  repo: 'FreeDocStore/true-non-profit',
  branch: 'main',
  path: 'docs/index.md',
  instruction: 'Make this page clearer for a new reader while preserving the same factual claims.',
}

const initialSteps: PublishStep[] = [
  { id: 'plan', label: 'Plan', detail: 'Create Zensical structure', state: 'idle' },
  { id: 'ai', label: 'Draft', detail: 'Generate Markdown files', state: 'idle' },
  { id: 'repo', label: 'Repo', detail: 'Create GitHub repository', state: 'idle' },
  { id: 'files', label: 'Files', detail: 'Commit Zensical source', state: 'idle' },
  { id: 'secrets', label: 'Secrets', detail: 'Set Cloudflare secrets', state: 'idle' },
  { id: 'deploy', label: 'Deploy', detail: 'GitHub Actions publishes to Cloudflare', state: 'idle' },
]

function App() {
  return (
    <ProShell app={app} appName="FreeDocStore Editor" allowFree showThemeToggle>
      <EditorApp />
    </ProShell>
  )
}

function EditorApp() {
  const { user } = useAuth(app)
  const [mode, setMode] = useState<Mode>('publish')
  const [settings, setSettings] = useState<Settings>(emptySettings)
  const [publishForm, setPublishForm] = useState<PublishForm>(starterPublish)
  const [editForm, setEditForm] = useState<EditForm>(starterEdit)
  const [files, setFiles] = useState<RepoFile[]>([])
  const [source, setSource] = useState('')
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [diff, setDiff] = useState('')
  const [activePreview, setActivePreview] = useState<'files' | 'source' | 'proposal' | 'diff'>('files')
  const [steps, setSteps] = useState<PublishStep[]>(initialSteps)
  const [status, setStatus] = useState('Ready')
  const [busy, setBusy] = useState(false)
  const [liveUrl, setLiveUrl] = useState('')

  useEffect(() => {
    const saved = sessionStorage.getItem('fds-editor-settings')
    if (saved) setSettings({ ...emptySettings, ...JSON.parse(saved) })
    const pub = localStorage.getItem('fds-publish-draft')
    if (pub) setPublishForm({ ...starterPublish, ...JSON.parse(pub) })
    const edit = localStorage.getItem('fds-edit-draft')
    if (edit) setEditForm({ ...starterEdit, ...JSON.parse(edit) })
  }, [])

  useEffect(() => {
    sessionStorage.setItem('fds-editor-settings', JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    localStorage.setItem('fds-publish-draft', JSON.stringify(publishForm))
  }, [publishForm])

  useEffect(() => {
    localStorage.setItem('fds-edit-draft', JSON.stringify(editForm))
  }, [editForm])

  const generatedSummary = useMemo(() => {
    if (!files.length) return 'No files generated yet.'
    return `${files.length} file${files.length === 1 ? '' : 's'} ready: ${files.map((f) => f.path).join(', ')}`
  }, [files])

  async function generateFiles() {
    setBusy(true)
    setStatus('Generating Zensical KB files')
    setSteps(resetSteps('plan', 'busy'))
    try {
      validatePublishForm(publishForm)
      validateAi(settings)
      setSteps(updateStep('plan', 'ok', 'Zensical contract ready'))
      setSteps(updateStep('ai', 'busy', 'Asking AI for source files'))
      const nextFiles = await generateKbFiles(settings, publishForm)
      validateKbFiles(nextFiles)
      setFiles(nextFiles)
      setActivePreview('files')
      setSteps(updateStep('ai', 'ok', `${nextFiles.length} files generated`))
      setStatus('Files generated. Review, then publish.')
    } catch (error) {
      setStatus(messageOf(error))
      setSteps(markCurrentError(steps))
    } finally {
      setBusy(false)
    }
  }

  async function publishToGitHub() {
    setBusy(true)
    setStatus('Publishing KB repo')
    try {
      if (!files.length) {
        await generateFiles()
      }
      const readyFiles = files.length ? files : await generateKbFiles(settings, publishForm)
      validatePublishForm(publishForm)
      validateKbFiles(readyFiles)
      validateGitHub(settings)
      validateCloudflare(settings)

      setSteps(updateStep('repo', 'busy', 'Creating repository'))
      const repo = await createRepo(settings.githubToken, publishForm)
      setSteps(updateStep('repo', 'ok', repo.html_url))

      setSteps(updateStep('files', 'busy', 'Writing files to main'))
      await writeFiles(settings.githubToken, repo.full_name, readyFiles)
      setSteps(updateStep('files', 'ok', `${readyFiles.length} files committed`))

      setSteps(updateStep('secrets', 'busy', 'Saving Cloudflare secrets'))
      await putGitHubSecret(settings.githubToken, repo.full_name, 'CLOUDFLARE_ACCOUNT_ID', settings.cloudflareAccountId)
      await putGitHubSecret(settings.githubToken, repo.full_name, 'CLOUDFLARE_API_TOKEN', settings.cloudflareApiToken)
      setSteps(updateStep('secrets', 'ok', 'Repository secrets configured'))

      const url = `https://${publishForm.slug}.pages.dev/`
      setLiveUrl(publishForm.customDomain ? `https://${publishForm.customDomain}/` : url)
      setSteps(updateStep('deploy', 'ok', 'Workflow started on GitHub'))
      setStatus('Published. GitHub Actions is building the Zensical site.')
      window.open(`${repo.html_url}/actions`, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setStatus(messageOf(error))
      setSteps(markCurrentError(steps))
    } finally {
      setBusy(false)
    }
  }

  async function loadSource() {
    setBusy(true)
    setStatus('Loading source')
    try {
      validateGitHub(settings)
      const content = await readGitHubFile(settings.githubToken, editForm.repo, editForm.path, editForm.branch)
      setSource(content)
      setProposal(null)
      setDiff('Source loaded. Ask AI for a proposal.')
      setActivePreview('source')
      setStatus('Source loaded')
    } catch (error) {
      setStatus(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  async function askForEditProposal() {
    setBusy(true)
    setStatus('Asking AI for proposal')
    try {
      validateAi(settings)
      const current = source || (await readGitHubFile(settings.githubToken, editForm.repo, editForm.path, editForm.branch))
      setSource(current)
      const next = await generateEditProposal(settings, editForm, current)
      setProposal(next)
      setDiff(buildLineDiff(current, next.content))
      setActivePreview('diff')
      setStatus('Proposal ready')
    } catch (error) {
      setStatus(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="app-shell">
      <header className="workspace-head">
        <div>
          <p className="eyebrow">Zensical only</p>
          <h1>Prompt and publish knowledge bases.</h1>
          <p className="lede">
            Create a Markdown repo, generate a Zensical book, push it to GitHub, and let Cloudflare Pages publish it.
          </p>
        </div>
        <div className="status-block" aria-live="polite">
          <span className={busy ? 'pulse-dot busy' : 'pulse-dot'} />
          <div>
            <strong>{busy ? 'Working' : 'Status'}</strong>
            <p>{status}</p>
            {user?.name && <small>Signed in to PAS as {user.name}</small>}
          </div>
        </div>
      </header>

      <section className="modebar" aria-label="Editor modes">
        <button className={mode === 'publish' ? 'mode active' : 'mode'} onClick={() => setMode('publish')} type="button">
          <Rocket size={17} />
          Publish KB
        </button>
        <button className={mode === 'edit' ? 'mode active' : 'mode'} onClick={() => setMode('edit')} type="button">
          <PenLine size={17} />
          Edit Markdown
        </button>
        <a className="mode link-mode" href={FDS_MCP} target="_blank" rel="noreferrer">
          <ShieldCheck size={17} />
          MCP
        </a>
      </section>

      <div className="workspace-grid">
        <section className="panel control-panel">
          <SettingsPanel settings={settings} setSettings={setSettings} />
          {mode === 'publish' ? (
            <PublishPanel
              form={publishForm}
              setForm={setPublishForm}
              steps={steps}
              busy={busy}
              onGenerate={generateFiles}
              onPublish={publishToGitHub}
              liveUrl={liveUrl}
            />
          ) : (
            <EditPanel
              form={editForm}
              setForm={setEditForm}
              busy={busy}
              onLoad={loadSource}
              onAsk={askForEditProposal}
              proposal={proposal}
            />
          )}
        </section>

        <section className="panel preview-panel">
          <PreviewTabs mode={mode} active={activePreview} setActive={setActivePreview} hasProposal={!!proposal} />
          {mode === 'publish' ? (
            <FilesPreview files={files} summary={generatedSummary} />
          ) : (
            <EditPreview active={activePreview} source={source} proposal={proposal} diff={diff} path={editForm.path} />
          )}
        </section>
      </div>
      <footer className="pas-footer">
        Built for <a href="https://proappstore.online" target="_blank" rel="noreferrer">proappstore.online</a>
      </footer>
    </main>
  )
}

function SettingsPanel({ settings, setSettings }: { settings: Settings; setSettings: (s: Settings) => void }) {
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings({ ...settings, [key]: value })
  return (
    <div className="section-block">
      <div className="section-title">
        <KeyRound size={18} />
        <div>
          <h2>Session keys</h2>
          <p>Stored in this browser session. Needed for self-serve publishing.</p>
        </div>
      </div>
      <div className="field-grid two">
        <Field label="GitHub token" value={settings.githubToken} onChange={(v) => update('githubToken', v)} secret placeholder="ghp_..." />
        <Field label="OpenAI API key" value={settings.openaiKey} onChange={(v) => update('openaiKey', v)} secret placeholder="sk-..." />
        <Field label="Cloudflare account ID" value={settings.cloudflareAccountId} onChange={(v) => update('cloudflareAccountId', v)} placeholder="Account ID" />
        <Field label="Cloudflare API token" value={settings.cloudflareApiToken} onChange={(v) => update('cloudflareApiToken', v)} secret placeholder="Pages edit token" />
        <Field label="OpenAI endpoint" value={settings.openaiEndpoint} onChange={(v) => update('openaiEndpoint', v)} />
        <Field label="Model" value={settings.model} onChange={(v) => update('model', v)} />
      </div>
    </div>
  )
}

function PublishPanel({
  form,
  setForm,
  steps,
  busy,
  onGenerate,
  onPublish,
  liveUrl,
}: {
  form: PublishForm
  setForm: (form: PublishForm) => void
  steps: PublishStep[]
  busy: boolean
  onGenerate: () => void
  onPublish: () => void
  liveUrl: string
}) {
  const update = <K extends keyof PublishForm>(key: K, value: PublishForm[K]) => setForm({ ...form, [key]: value })
  return (
    <div className="section-block">
      <div className="section-title">
        <BookOpen size={18} />
        <div>
          <h2>New knowledge base</h2>
          <p>Generates a Zensical Markdown repo and deploy workflow.</p>
        </div>
      </div>
      <div className="field-grid two">
        <Field label="Title" value={form.title} onChange={(v) => update('title', v)} />
        <Field label="Slug / Pages project" value={form.slug} onChange={(v) => update('slug', slugify(v))} />
        <Field label="GitHub owner" value={form.owner} onChange={(v) => update('owner', v)} />
        <Field label="Custom domain" value={form.customDomain} onChange={(v) => update('customDomain', v.replace(/^https?:\/\//, '').replace(/\/$/, ''))} placeholder="docs.example.com" />
      </div>
      <label className="field">
        <span>Knowledge-base prompt</span>
        <textarea value={form.prompt} onChange={(e) => update('prompt', e.target.value)} rows={8} />
      </label>
      <div className="inline-choice">
        <button type="button" className={form.visibility === 'public' ? 'choice active' : 'choice'} onClick={() => update('visibility', 'public')}>
          Public
        </button>
        <button type="button" className={form.visibility === 'private' ? 'choice active' : 'choice'} onClick={() => update('visibility', 'private')}>
          Private repo
        </button>
      </div>
      <div className="action-row">
        <button className="secondary-action" type="button" onClick={onGenerate} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
          Generate files
        </button>
        <button className="primary-action" type="button" onClick={onPublish} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Rocket size={17} />}
          Publish repo
        </button>
      </div>
      <div className="steps" aria-label="Publish progress">
        {steps.map((step) => (
          <div className={`step ${step.state}`} key={step.id}>
            <span>{step.state === 'busy' ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}</span>
            <div>
              <strong>{step.label}</strong>
              <p>{step.detail}</p>
            </div>
          </div>
        ))}
      </div>
      {liveUrl && (
        <a className="live-link" href={liveUrl} target="_blank" rel="noreferrer">
          <Cloud size={17} />
          Open live KB target
        </a>
      )}
    </div>
  )
}

function EditPanel({
  form,
  setForm,
  busy,
  onLoad,
  onAsk,
  proposal,
}: {
  form: EditForm
  setForm: (form: EditForm) => void
  busy: boolean
  onLoad: () => void
  onAsk: () => void
  proposal: Proposal | null
}) {
  const update = <K extends keyof EditForm>(key: K, value: EditForm[K]) => setForm({ ...form, [key]: value })
  const githubEdit = githubEditUrl(form)
  return (
    <div className="section-block">
      <div className="section-title">
        <FileText size={18} />
        <div>
          <h2>Edit existing Markdown</h2>
          <p>AI drafts a full replacement. Manual edits stay in GitHub.</p>
        </div>
      </div>
      <div className="field-grid two">
        <Field label="Repo" value={form.repo} onChange={(v) => update('repo', v)} placeholder="owner/repo" />
        <Field label="Branch" value={form.branch} onChange={(v) => update('branch', v)} />
      </div>
      <Field label="Path" value={form.path} onChange={(v) => update('path', v)} placeholder="docs/index.md" />
      <label className="field">
        <span>Change request</span>
        <textarea value={form.instruction} onChange={(e) => update('instruction', e.target.value)} rows={8} />
      </label>
      <div className="action-row">
        <button className="secondary-action" type="button" onClick={onLoad} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Download size={17} />}
          Load source
        </button>
        <button className="primary-action" type="button" onClick={onAsk} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
          Ask AI
        </button>
      </div>
      <div className="action-row compact-actions">
        <a className="secondary-action as-link" href={githubEdit} target="_blank" rel="noreferrer">
          <Github size={17} />
          Open GitHub editor
        </a>
        <button
          className="secondary-action"
          type="button"
          disabled={!proposal}
          onClick={() => proposal && navigator.clipboard.writeText(proposal.content)}
        >
          <Copy size={17} />
          Copy proposal
        </button>
      </div>
    </div>
  )
}

function PreviewTabs({
  mode,
  active,
  setActive,
  hasProposal,
}: {
  mode: Mode
  active: 'files' | 'source' | 'proposal' | 'diff'
  setActive: (tab: 'files' | 'source' | 'proposal' | 'diff') => void
  hasProposal: boolean
}) {
  if (mode === 'publish') {
    return (
      <div className="preview-tabs">
        <button className="preview-tab active" type="button" onClick={() => setActive('files')}>
          Generated files
        </button>
      </div>
    )
  }
  return (
    <div className="preview-tabs">
      <button className={active === 'diff' ? 'preview-tab active' : 'preview-tab'} type="button" onClick={() => setActive('diff')}>
        Diff
      </button>
      <button className={active === 'proposal' ? 'preview-tab active' : 'preview-tab'} type="button" onClick={() => setActive('proposal')} disabled={!hasProposal}>
        Proposal
      </button>
      <button className={active === 'source' ? 'preview-tab active' : 'preview-tab'} type="button" onClick={() => setActive('source')}>
        Source
      </button>
    </div>
  )
}

function FilesPreview({ files, summary }: { files: RepoFile[]; summary: string }) {
  const [selected, setSelected] = useState('')
  const current = files.find((file) => file.path === selected) ?? files[0]
  useEffect(() => {
    if (files[0] && !files.some((file) => file.path === selected)) setSelected(files[0].path)
  }, [files, selected])
  return (
    <div className="preview-body">
      <div className="preview-summary">
        <strong>{summary}</strong>
        <p>Review before publishing. Generated files must stay Markdown/Zensical source, not committed static output.</p>
      </div>
      {files.length > 0 ? (
        <div className="file-preview-layout">
          <div className="file-list">
            {files.map((file) => (
              <button key={file.path} className={current?.path === file.path ? 'file-row active' : 'file-row'} onClick={() => setSelected(file.path)} type="button">
                {file.path}
              </button>
            ))}
          </div>
          <pre className="code-view">{current?.content}</pre>
        </div>
      ) : (
        <div className="empty-state">
          <Sparkles size={24} />
          <p>Generate a KB to preview the Markdown repo files here.</p>
        </div>
      )}
    </div>
  )
}

function EditPreview({
  active,
  source,
  proposal,
  diff,
  path,
}: {
  active: 'files' | 'source' | 'proposal' | 'diff'
  source: string
  proposal: Proposal | null
  diff: string
  path: string
}) {
  const text = active === 'proposal' ? proposal?.content ?? '' : active === 'source' ? source : diff
  return (
    <div className="preview-body">
      <div className="preview-summary">
        <strong>{proposal?.summary ?? path}</strong>
        <p>{proposal?.rationale ?? 'Load a Markdown file and ask AI for a replacement proposal.'}</p>
      </div>
      <pre className="code-view">{text || 'Nothing to preview yet.'}</pre>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  secret?: boolean
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type={secret ? 'password' : 'text'} />
    </label>
  )
}

async function generateKbFiles(settings: Settings, form: PublishForm): Promise<RepoFile[]> {
  const workflow = deployWorkflow(form.slug, form.customDomain)
  const system = [
    'You generate FreeDocStore knowledge bases.',
    'Only output GitHub repo source files for a Zensical project.',
    'Do not output generated HTML or static site output.',
    'Use Markdown under docs/, zensical.toml at the repo root, and a concise README.',
    'Return only JSON: {"files":[{"path":"...","content":"..."}]}',
  ].join(' ')
  const user = [
    `Title: ${form.title}`,
    `Slug: ${form.slug}`,
    `Production URL: https://${form.slug}.pages.dev/`,
    form.customDomain ? `Custom domain: https://${form.customDomain}/` : 'Custom domain: none',
    '',
    'Required files:',
    '- README.md',
    '- .gitignore',
    '- zensical.toml',
    '- docs/index.md',
    '- docs/first-principles.md',
    '- docs/assessment-method.md',
    '- docs/register.md',
    '',
    'Knowledge-base prompt:',
    form.prompt,
  ].join('\n')
  const json = await callOpenAi(settings, system, user)
  const parsed = parseJson(json) as { files?: RepoFile[] }
  const aiFiles = Array.isArray(parsed.files) ? parsed.files : []
  const normalized = aiFiles
    .filter((file) => typeof file.path === 'string' && typeof file.content === 'string')
    .map((file) => ({ path: file.path.replace(/^\/+/, ''), content: file.content }))
    .filter((file) => !file.path.startsWith('site/') && !file.path.endsWith('.html'))
  const withRequired = upsertFile(normalized, '.github/workflows/deploy.yml', workflow)
  return ensureFallbackFiles(withRequired, form, workflow)
}

async function generateEditProposal(settings: Settings, form: EditForm, current: string): Promise<Proposal> {
  const system = [
    'You are an AI-first Markdown knowledge-base editor.',
    'Return a complete replacement for the file, not a patch.',
    'Preserve truthful facts and formatting unless the request changes them.',
    'Do not invent dates, legal claims, prices, or product capabilities.',
    'Return only JSON: {"summary":"...","rationale":"...","content":"..."}',
  ].join(' ')
  const user = [`Path: ${form.path}`, '', 'Current source:', '```', current, '```', '', 'Request:', form.instruction].join('\n')
  const json = await callOpenAi(settings, system, user)
  const parsed = parseJson(json) as Proposal
  if (!parsed.content?.trim()) throw new Error('AI response did not include replacement content.')
  return parsed
}

async function callOpenAi(settings: Settings, system: string, user: string): Promise<string> {
  const res = await fetch(settings.openaiEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openaiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) throw new Error(`OpenAI request failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('OpenAI returned no content.')
  return content
}

async function createRepo(token: string, form: PublishForm) {
  const viewer = await githubJson(token, 'https://api.github.com/user')
  const isUser = viewer.login?.toLowerCase() === form.owner.toLowerCase()
  const url = isUser ? 'https://api.github.com/user/repos' : `https://api.github.com/orgs/${encodeURIComponent(form.owner)}/repos`
  const res = await fetch(url, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({
      name: form.slug,
      description: `${form.title} - FreeDocStore Zensical knowledge base`,
      private: form.visibility === 'private',
      auto_init: true,
      homepage: form.customDomain ? `https://${form.customDomain}/` : `https://${form.slug}.pages.dev/`,
    }),
  })
  if (res.status === 422) {
    return githubJson(token, `https://api.github.com/repos/${encodeURIComponent(form.owner)}/${encodeURIComponent(form.slug)}`)
  }
  if (!res.ok) throw new Error(`GitHub repo create failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function writeFiles(token: string, repo: string, files: RepoFile[]) {
  for (const file of files) {
    await writeGitHubFile(token, repo, file.path, file.content)
  }
}

async function writeGitHubFile(token: string, repo: string, path: string, content: string) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const url = `https://api.github.com/repos/${repo}/contents/${encodedPath}`
  let sha: string | undefined
  const existing = await fetch(url, { headers: githubHeaders(token) })
  if (existing.ok) {
    const json = await existing.json()
    sha = json.sha
  }
  const res = await fetch(url, {
    method: 'PUT',
    headers: githubHeaders(token),
    body: JSON.stringify({
      message: `${sha ? 'Update' : 'Add'} ${path}`,
      content: textToBase64(content),
      sha,
    }),
  })
  if (!res.ok) throw new Error(`GitHub write failed for ${path}: ${res.status} ${await res.text()}`)
}

async function readGitHubFile(token: string, repo: string, path: string, branch: string) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, {
    headers: githubHeaders(token),
  })
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`)
  const json = await res.json()
  if (json.encoding !== 'base64' || typeof json.content !== 'string') throw new Error('GitHub path is not a text file.')
  return base64ToText(json.content)
}

async function putGitHubSecret(token: string, repo: string, name: string, value: string) {
  const sodium = (await import('libsodium-wrappers')).default
  await sodium.ready
  const key = await githubJson(token, `https://api.github.com/repos/${repo}/actions/secrets/public-key`)
  const encrypted = sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL)),
    sodium.base64_variants.ORIGINAL,
  )
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${name}`, {
    method: 'PUT',
    headers: githubHeaders(token),
    body: JSON.stringify({ encrypted_value: encrypted, key_id: key.key_id }),
  })
  if (!res.ok) throw new Error(`GitHub secret ${name} failed: ${res.status} ${await res.text()}`)
}

function deployWorkflow(project: string, customDomain: string) {
  const domainStep = customDomain
    ? `
      - name: Attach custom domain
        run: npx wrangler pages domain add ${customDomain} --project-name=${project} || true
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`
    : ''
  return `name: Deploy Zensical KB

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  deployments: write

concurrency:
  group: deploy-zensical
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: python -m pip install zensical
      - run: python -m zensical build --strict
      - name: Ensure Cloudflare Pages project
        run: npx wrangler pages project create ${project} --production-branch=main || true
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - name: Deploy to Cloudflare Pages
        run: npx wrangler pages deploy site --project-name=${project} --branch=main
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
${domainStep}`
}

function ensureFallbackFiles(files: RepoFile[], form: PublishForm, workflow: string): RepoFile[] {
  let next = [...files]
  next = upsertFile(next, '.github/workflows/deploy.yml', workflow)
  next = upsertFile(next, '.gitignore', 'site/\n.cache/\n.DS_Store\n')
  if (!next.some((file) => file.path === 'README.md')) {
    next.push({ path: 'README.md', content: `# ${form.title}\n\nFreeDocStore Zensical knowledge base.\n\nSource lives in \`docs/\` and builds with \`python -m zensical build --strict\`.\n` })
  }
  if (!next.some((file) => file.path === 'zensical.toml')) {
    next.push({
      path: 'zensical.toml',
      content: `site_name = "${form.title.replace(/"/g, '\\"')}"\nsite_url = "https://${form.slug}.pages.dev/"\nrepo_url = "https://github.com/${form.owner}/${form.slug}"\ndocs_dir = "docs"\nsite_dir = "site"\n\n[nav]\nitems = [\n  { title = "Overview", path = "index.md" },\n  { title = "First Principles", path = "first-principles.md" },\n  { title = "Assessment Method", path = "assessment-method.md" },\n  { title = "Register", path = "register.md" },\n]\n`,
    })
  }
  if (!next.some((file) => file.path === 'docs/index.md')) {
    next.push({ path: 'docs/index.md', content: `# ${form.title}\n\n${form.prompt}\n` })
  }
  return next.sort((a, b) => a.path.localeCompare(b.path))
}

function validateKbFiles(files: RepoFile[]) {
  const paths = new Set(files.map((file) => file.path))
  const failures = [
    ['zensical.toml', !paths.has('zensical.toml')],
    ['docs/index.md', !paths.has('docs/index.md')],
    ['Markdown under docs/', !files.some((file) => file.path.startsWith('docs/') && file.path.endsWith('.md'))],
    ['no generated site output', files.some((file) => file.path.startsWith('site/') || file.path.endsWith('.html'))],
  ].filter(([, failed]) => failed)
  if (failures.length) throw new Error(`Generated files failed Zensical validation: ${failures.map(([name]) => name).join(', ')}`)
}

function validatePublishForm(form: PublishForm) {
  if (!form.title.trim()) throw new Error('Title is required.')
  if (!/^[a-z][a-z0-9-]{1,57}$/.test(form.slug)) throw new Error('Slug must be lowercase letters, numbers, and hyphens.')
  if (!form.owner.trim()) throw new Error('GitHub owner is required.')
  if (!form.prompt.trim()) throw new Error('Prompt is required.')
}

function validateAi(settings: Settings) {
  if (!settings.openaiKey.trim()) throw new Error('OpenAI API key is required.')
  if (!settings.openaiEndpoint.trim()) throw new Error('OpenAI endpoint is required.')
  if (!settings.model.trim()) throw new Error('Model is required.')
}

function validateGitHub(settings: Settings) {
  if (!settings.githubToken.trim()) throw new Error('GitHub token is required.')
}

function validateCloudflare(settings: Settings) {
  if (!settings.cloudflareAccountId.trim()) throw new Error('Cloudflare account ID is required.')
  if (!settings.cloudflareApiToken.trim()) throw new Error('Cloudflare API token is required.')
}

function githubHeaders(token: string) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function githubJson(token: string, url: string) {
  const res = await fetch(url, { headers: githubHeaders(token) })
  if (!res.ok) throw new Error(`GitHub API failed: ${res.status} ${await res.text()}`)
  return res.json()
}

function upsertFile(files: RepoFile[], path: string, content: string) {
  const without = files.filter((file) => file.path !== path)
  return [...without, { path, content }]
}

function parseJson(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('AI did not return JSON.')
    return JSON.parse(match[0])
  }
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 58)
}

function textToBase64(text: string) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToText(value: string) {
  const binary = atob(value.replace(/\n/g, ''))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function githubEditUrl(form: EditForm) {
  const [owner, repo] = form.repo.split('/')
  const path = form.path.split('/').map(encodeURIComponent).join('/')
  return owner && repo ? `https://github.com/${owner}/${repo}/edit/${encodeURIComponent(form.branch || 'main')}/${path}` : 'https://github.com'
}

function buildLineDiff(before: string, after: string) {
  if (before === after) return 'No content changes proposed.'
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1])
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i++]}`)
      j++
    } else if (rows[i + 1][j] >= rows[i][j + 1]) out.push(`- ${a[i++]}`)
    else out.push(`+ ${b[j++]}`)
  }
  while (i < a.length) out.push(`- ${a[i++]}`)
  while (j < b.length) out.push(`+ ${b[j++]}`)
  return out.join('\n')
}

function resetSteps(active: string, state: StepState) {
  return initialSteps.map((step) => ({ ...step, state: step.id === active ? state : 'idle' as StepState }))
}

function updateStep(id: string, state: StepState, detail: string) {
  return (prev: PublishStep[]) => prev.map((step) => (step.id === id ? { ...step, state, detail } : step))
}

function markCurrentError(current: PublishStep[]) {
  const busy = current.find((step) => step.state === 'busy')
  if (!busy) return current
  return current.map((step) => (step.id === busy.id ? { ...step, state: 'error' as StepState } : step))
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export default App
