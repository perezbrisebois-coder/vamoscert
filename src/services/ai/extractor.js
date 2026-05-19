// Client-side text extraction for Word and web pages
// PDFs are handled via pdf.js, Word via mammoth

export const extractFromWord = async (file) => {
  const mammoth = await import('mammoth')
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
  return result.value
}

export const extractFromWebpage = async (url) => {
  // Use a CORS proxy + extract meaningful text
  // We fetch via our own Firebase Function to avoid CORS
  const response = await fetch(`/api/extract-webpage?url=${encodeURIComponent(url)}`)
  if (!response.ok) throw new Error('Could not fetch webpage')
  const data = await response.json()
  return data.text
}

export const extractFromPdf = async (file) => {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`

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

export const extractText = async (file, type) => {
  switch (type) {
    case 'word': return await extractFromWord(file)
    case 'pdf': return await extractFromPdf(file)
    default: throw new Error(`Unsupported file type: ${type}`)
  }
}
