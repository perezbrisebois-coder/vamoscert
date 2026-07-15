// Client-side text extraction for Word, PDF, and ePub files

export const extractFromWord = async (file) => {
  const mammoth = await import('mammoth')
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
  return result.value
}

export const extractFromWebpage = async (url) => {
  const response = await fetch(`/api/extract-webpage?url=${encodeURIComponent(url)}`)
  if (!response.ok) throw new Error('Could not fetch webpage')
  const data = await response.json()
  return data.text
}

export const extractFromPdf = async (file) => {
  const pdfjsLib = await import('pdfjs-dist')
  const { default: workerSrc } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  let fullText = ''

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const pageText = content.items.map(item => item.str).join(' ')
    fullText += pageText + '\n\n'
  }

  return fullText.trim()
}

export const extractFromEpub = async (file) => {
  const JSZip = (await import('jszip')).default
  const arrayBuffer = await file.arrayBuffer()
  const zip = await JSZip.loadAsync(arrayBuffer)

  // Locate the OPF package file via container.xml
  const containerXml = await zip.file('META-INF/container.xml')?.async('text')
  if (!containerXml) throw new Error('Invalid ePub: missing META-INF/container.xml')

  const opfMatch = containerXml.match(/full-path="([^"]+\.opf)"/)
  if (!opfMatch) throw new Error('Invalid ePub: cannot find OPF path in container.xml')
  const opfPath = opfMatch[1]
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : ''

  const opfXml = await zip.file(opfPath)?.async('text')
  if (!opfXml) throw new Error('Invalid ePub: cannot read OPF file')

  // Build manifest: id → href. Attribute order varies between ePub-generation tools
  // (Calibre/Sigil/pandoc commonly write href before id) so parse each attribute
  // independently instead of requiring a fixed order.
  const manifest = {}
  for (const itemTag of opfXml.matchAll(/<item\b[^>]*\/?>/gi)) {
    const tag = itemTag[0]
    const idMatch = tag.match(/\bid=["']([^"']+)["']/)
    const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/)
    if (idMatch && hrefMatch) manifest[idMatch[1]] = hrefMatch[1]
  }

  // Follow spine reading order
  const spineIds = [...opfXml.matchAll(/<itemref\b[^>]*\bidref=["']([^"']+)["']/gi)].map(m => m[1])

  const stripHtml = (html) => html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim()

  let fullText = ''
  for (const id of spineIds) {
    const href = manifest[id]
    if (!href) continue
    const contentPath = opfDir + href.split('#')[0]
    const contentFile = zip.file(contentPath)
    if (!contentFile) continue
    const html = await contentFile.async('text')
    const text = stripHtml(html)
    if (text) fullText += text + '\n\n'
  }

  const result = fullText.trim()
  if (!result) throw new Error('Could not extract any readable text from this ePub — the spine or manifest may be in a format this parser cannot read.')
  return result
}

export const extractText = async (file, type) => {
  switch (type) {
    case 'word': return await extractFromWord(file)
    case 'pdf': return await extractFromPdf(file)
    case 'epub': return await extractFromEpub(file)
    default: throw new Error(`Unsupported file type: ${type}`)
  }
}
