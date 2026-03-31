import { execFileSync, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { DatabaseSync } from 'node:sqlite'

const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const ACCEPTED_LICENSES = [
  'MIT', 'Apache-2.0', 'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0',
  'BSD-2-Clause', 'BSD-3-Clause', 'MPL-2.0', 'ISC', 'Unlicense', 'CC0-1.0',
]

interface PluginEntry {
  name: string
  title: string
  description: string
  version: string
  author: string
  repository: string
  license: string
  download_url: string
  github_user: string
  tags: string[]
}

interface PluginRow {
  name: string
  title: string
  description: string
  version: string
  author: string | null
  repository: string | null
  license: string | null
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf-8' }).trim()
}

function commentAndClose(issueNumber: string, body: string, label: string): void {
  const tmpFile = path.join(os.tmpdir(), `gh-comment-${issueNumber}.md`)
  fs.writeFileSync(tmpFile, body)
  try {
    gh(['issue', 'comment', issueNumber, '--body-file', tmpFile])
  } finally {
    fs.unlinkSync(tmpFile)
  }
  gh(['issue', 'edit', issueNumber, '--add-label', label])
  gh(['issue', 'close', issueNumber])
}

function commentError(issueNumber: string, errors: string[]): void {
  const body = `## Validation Failed\n\n${errors.map(e => `- ${e}`).join('\n')}\n\nPlease fix the issues and open a new request.`
  commentAndClose(issueNumber, body, 'invalid')
}

function parseIssueField(body: string, fieldId: string): string {
  // GitHub issue forms render as "### Label\n\nvalue\n\n### Next Label"
  const lines = body.split('\n')
  let capture = false
  const values: string[] = []
  const normalizedId = fieldId.toLowerCase().replace(/[_\s]+/g, '_')
  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (capture) break
      const heading = line.replace('### ', '').trim().toLowerCase().replace(/[_\s]+/g, '_')
      if (heading === normalizedId) {
        capture = true
        continue
      }
    } else if (capture && line.trim()) {
      values.push(line.trim())
    }
  }
  return values.join('\n')
}

async function main() {
  const issueNumber = process.env.ISSUE_NUMBER!
  const issueBody = process.env.ISSUE_BODY!
  const issueLabels: string[] = JSON.parse(process.env.ISSUE_LABELS || '[]')
  const issueAuthor = process.env.ISSUE_AUTHOR || ''

  if (!issueLabels.includes('approved')) {
    console.log('Missing "approved" label, skipping.')
    return
  }

  const isPublish = issueLabels.includes('publish')
  const isUpdate = issueLabels.includes('update')
  const isRemove = issueLabels.includes('remove')

  if (!isPublish && !isUpdate && !isRemove) {
    console.log('No recognized label (publish/update/remove), skipping.')
    return
  }

  const indexPath = path.resolve('index.json')
  const index: PluginEntry[] = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))

  if (isRemove) {
    const pluginName = parseIssueField(issueBody, 'plugin_name')
    if (!pluginName) {
      commentError(issueNumber, ['Plugin name is required.'])
      return
    }
    const idx = index.findIndex(p => p.name === pluginName)
    if (idx === -1) {
      commentError(issueNumber, [`Plugin '${pluginName}' not found in registry.`])
      return
    }
    const existing = index[idx]
    if (issueAuthor !== existing.github_user) {
      commentError(issueNumber, ['Only the original publisher can remove this plugin.'])
      return
    }
    index.splice(idx, 1)
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n')
    execFileSync('git', ['add', 'index.json'])
    execFileSync('git', ['commit', '-m', `Remove plugin: ${pluginName}`])
    execFileSync('git', ['push'])
    commentAndClose(issueNumber, `Plugin \`${pluginName}\` has been removed from the registry.`, 'removed')
    return
  }

  // Publish or Update
  const downloadUrl = parseIssueField(issueBody, 'download_url')
  if (!downloadUrl || !downloadUrl.startsWith('https://')) {
    commentError(issueNumber, ['A valid HTTPS download URL is required.'])
    return
  }

  // Download the package
  const tmpPath = path.join(os.tmpdir(), 'plugin.plugins.awfy')
  try {
    execFileSync('curl', ['-fSL', '-o', tmpPath, downloadUrl], { timeout: 30_000 })
  } catch {
    commentError(issueNumber, [`Failed to download package from: ${downloadUrl}`])
    return
  }

  // Open as SQLite and extract metadata
  const errors: string[] = []
  let pluginData: PluginRow | null = null

  try {
    const db = new DatabaseSync(tmpPath)
    try {
      let rows: PluginRow[]
      try {
        rows = db.prepare('SELECT name, title, description, version, author, repository, license FROM plugins').all() as PluginRow[]
      } catch {
        try {
          const withoutTitle = db.prepare('SELECT name, description, version, author, repository, license FROM plugins').all() as Array<Omit<PluginRow, 'title'>>
          rows = withoutTitle.map(r => ({ ...r, title: '' }))
        } catch {
          const basic = db.prepare('SELECT name, description, version FROM plugins').all() as Array<{ name: string; description: string; version: string }>
          rows = basic.map(r => ({ ...r, title: '', author: null, repository: null, license: null }))
        }
      }

      if (rows.length === 0) {
        errors.push('Package contains no plugins.')
      } else if (rows.length > 1) {
        errors.push('Registry only supports single-plugin packages.')
      } else {
        pluginData = rows[0]
      }
    } finally {
      db.close()
    }
  } catch (err) {
    errors.push(`Failed to read package as SQLite: ${err}`)
  }

  if (errors.length > 0) {
    commentError(issueNumber, errors)
    return
  }

  const data = pluginData!
  // Validate required fields
  if (!data.name?.trim()) errors.push('Missing required field: name')
  if (data.name && !PLUGIN_NAME_RE.test(data.name)) {
    errors.push(`Plugin name '${data.name}' must contain only lowercase letters, digits, and hyphens`)
  }
  if (!data.description?.trim()) errors.push('Missing required field: description')
  if (!data.version?.trim()) errors.push('Missing required field: version')
  if (!data.author?.trim()) errors.push('Missing required field: author (add `author` column to your plugins table)')
  if (!data.license?.trim()) errors.push('Missing required field: license (add `license` column to your plugins table)')

  if (data.license && !ACCEPTED_LICENSES.includes(data.license)) {
    errors.push(`License '${data.license}' is not accepted. Accepted: ${ACCEPTED_LICENSES.join(', ')}`)
  }

  const existingIdx = index.findIndex(p => p.name === data.name)

  if (isPublish && existingIdx !== -1) {
    errors.push(`Plugin '${data.name}' already exists in the registry. Use "Update Plugin" instead.`)
  }
  if (isUpdate && existingIdx === -1) {
    errors.push(`Plugin '${data.name}' not found in registry. Use "Publish Plugin" instead.`)
  }
  if (isUpdate && existingIdx !== -1) {
    const existing = index[existingIdx]
    if (issueAuthor !== existing.github_user) {
      commentError(issueNumber, ['Only the original publisher can update this plugin.'])
      return
    }
    if (compareVersions(data.version, existing.version) <= 0) {
      errors.push(`Version ${data.version} is not newer than existing ${existing.version}.`)
    }
  }

  if (errors.length > 0) {
    commentError(issueNumber, errors)
    return
  }

  // Parse tags from checkboxes
  const tagsRaw = parseIssueField(issueBody, 'tags')
  const parsedTags = tagsRaw.split('\n')
    .filter(l => /\[x\]/i.test(l))
    .map(l => l.replace(/.*\[x\]\s*/i, '').trim())
    .filter(Boolean)
  // On update, keep existing tags if none were checked
  const tags = parsedTags.length > 0 || !isUpdate
    ? parsedTags
    : (index[existingIdx]?.tags ?? [])

  // Build the entry
  const entry: PluginEntry = {
    name: data.name,
    title: data.title || '',
    description: data.description,
    version: data.version,
    author: data.author!,
    repository: data.repository || '',
    license: data.license!,
    download_url: downloadUrl,
    github_user: issueAuthor,
    tags,
  }

  if (isUpdate) {
    index[existingIdx] = entry
  } else {
    index.push(entry)
  }

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n')
  execFileSync('git', ['config', 'user.name', 'github-actions[bot]'])
  execFileSync('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'])
  execFileSync('git', ['add', 'index.json'])
  const action = isUpdate ? 'Update' : 'Publish'
  execFileSync('git', ['commit', '-m', `${action} plugin: ${data.name} v${data.version}`])
  execFileSync('git', ['push'])

  const summary = [
    `## Plugin ${action === 'Publish' ? 'Published' : 'Updated'}`,
    '',
    `| Field | Value |`,
    `|---|---|`,
    `| **Name** | ${entry.name} |`,
    `| **Description** | ${entry.description} |`,
    `| **Version** | ${entry.version} |`,
    `| **Author** | ${entry.author} |`,
    `| **License** | ${entry.license} |`,
    `| **Repository** | ${entry.repository || 'N/A'} |`,
    `| **Download** | ${entry.download_url} |`,
  ].join('\n')

  commentAndClose(issueNumber, summary, 'published')
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
