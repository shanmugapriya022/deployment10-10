import React, { useState } from 'react';
import { Copy, Check, FileCode, Table } from 'lucide-react';
import { toast } from 'sonner';

interface FormattedJsonViewerProps {
  jsonText: string;
  totalRecords?: number;
  fileName?: string;
  viewMode?: 'json' | 'table';
  onToggleViewMode?: (mode: 'json' | 'table') => void;
  showToggle?: boolean;
}

export function highlightJsonLine(lineText: string): React.ReactNode {
  if (!lineText) return null;

  const tokenRegex = /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|[{}[\],])/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  const elements: React.ReactNode[] = [];
  let keyIdx = 0;

  while ((match = tokenRegex.exec(lineText)) !== null) {
    if (match.index > lastIndex) {
      elements.push(
        <span key={`txt-${keyIdx++}`} className="text-slate-300">
          {lineText.substring(lastIndex, match.index)}
        </span>
      );
    }

    const token = match[0];
    if (/^".*"\s*:$/.test(token)) {
      const colonIdx = token.lastIndexOf(':');
      const keyStr = token.substring(0, colonIdx);
      const spaceAndColon = token.substring(colonIdx);
      elements.push(
        <span key={`key-${keyIdx++}`} className="text-sky-300 font-semibold">
          {keyStr}
        </span>
      );
      elements.push(
        <span key={`col-${keyIdx++}`} className="text-slate-400">
          {spaceAndColon}
        </span>
      );
    } else if (/^".*"$/.test(token)) {
      elements.push(
        <span key={`str-${keyIdx++}`} className="text-emerald-300">
          {token}
        </span>
      );
    } else if (/^(true|false|null)$/.test(token)) {
      elements.push(
        <span key={`bool-${keyIdx++}`} className="text-purple-300 font-semibold">
          {token}
        </span>
      );
    } else if (/^-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?$/.test(token)) {
      elements.push(
        <span key={`num-${keyIdx++}`} className="text-cyan-300 font-mono">
          {token}
        </span>
      );
    } else {
      elements.push(
        <span key={`punc-${keyIdx++}`} className="text-slate-400">
          {token}
        </span>
      );
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < lineText.length) {
    elements.push(
      <span key={`txt-${keyIdx++}`} className="text-slate-300">
        {lineText.substring(lastIndex)}
      </span>
    );
  }

  return elements;
}

export const FormattedJsonViewer: React.FC<FormattedJsonViewerProps> = ({
  jsonText,
  totalRecords,
  fileName,
  viewMode = 'json',
  onToggleViewMode,
  showToggle = true
}) => {
  const [copied, setCopied] = useState(false);

  let formattedText = jsonText;
  try {
    const parsed = JSON.parse(jsonText);
    formattedText = JSON.stringify(parsed, null, 2);
  } catch (e) {
    // text remains as-is if already string or raw
  }

  const lines = formattedText.split('\n');

  const handleCopy = () => {
    navigator.clipboard.writeText(formattedText);
    setCopied(true);
    toast.success('JSON copied to clipboard!');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full">
      <div className="flex items-center justify-between pb-2 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-teal-900 uppercase tracking-wide flex items-center gap-1.5">
            <FileCode size={14} className="text-teal-600" />
            JSON DATASET PREVIEW {totalRecords !== undefined ? `(${totalRecords} RECORDS)` : ''}
          </span>
          {fileName && (
            <span className="text-[10px] bg-teal-50 text-teal-700 border border-teal-200 px-2 py-0.5 rounded-full font-mono">
              {fileName}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {showToggle && onToggleViewMode && (
            <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
              <button
                type="button"
                onClick={() => onToggleViewMode('json')}
                className={`px-2.5 py-1 text-[10px] font-bold rounded-md transition-all flex items-center gap-1 cursor-pointer ${
                  viewMode === 'json'
                    ? 'bg-teal-700 text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <FileCode size={11} />
                <span>JSON View</span>
              </button>
              <button
                type="button"
                onClick={() => onToggleViewMode('table')}
                className={`px-2.5 py-1 text-[10px] font-bold rounded-md transition-all flex items-center gap-1 cursor-pointer ${
                  viewMode === 'table'
                    ? 'bg-teal-700 text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Table size={11} />
                <span>Table View</span>
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className="px-2.5 py-1 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-bold rounded-lg transition-all flex items-center gap-1 cursor-pointer shadow-2xs"
            title="Copy JSON text"
          >
            {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} className="text-slate-500" />}
            <span>{copied ? 'Copied' : 'Copy JSON'}</span>
          </button>
        </div>
      </div>

      <div className="relative rounded-xl border border-slate-800 bg-[#0f172a] p-3 text-slate-100 max-h-72 overflow-auto font-mono text-xs scrollbar-thin shadow-inner">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((lineText, lineIdx) => (
              <tr key={lineIdx} className="hover:bg-slate-800/40">
                <td className="w-10 pr-3 text-right text-slate-500 select-none text-[11px] font-mono border-r border-slate-800/80 align-top">
                  {lineIdx + 1}
                </td>
                <td className="pl-3 whitespace-pre text-[12px] font-mono align-top leading-5">
                  {highlightJsonLine(lineText)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
