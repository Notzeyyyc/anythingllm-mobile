/**
 * Export/share a trace as one file (spec §7.1 M2b): markdown (conversation +
 * steps table) or JSON (raw events). Uses existing deps only.
 */
import Share from 'react-native-share';
import { writeToDeviceDownloads } from '@/utils/fs/deviceDownloads';
import {
  formatTurnJson,
  formatTurnMarkdown,
  type ExportFormat,
  type PocketChatEntry,
} from './chatStore';

export async function shareTrace(entries: PocketChatEntry[], format: ExportFormat) {
  const content =
    format === 'json' ? formatTurnJson(entries) : formatTurnMarkdown(entries);
  const saved = await writeToDeviceDownloads({
    filename: `pocket-trace-${Date.now()}.${format === 'json' ? 'json' : 'md'}`,
    content,
    encoding: 'utf8',
  });
  // react-native-share rejects when the user dismisses the sheet — treat as cancel.
  try {
    await Share.open({ title: saved.filename, url: `file://${saved.path}`, failOnCancel: false });
  } catch {
    /* dismissed */
  }
  return saved;
}
