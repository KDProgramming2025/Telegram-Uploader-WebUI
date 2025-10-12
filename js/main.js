import { initJobs } from './jobs.js';
import { initDownloadTree } from './dl-tree.js';

const { refreshDlList } = initDownloadTree();
initJobs({ onDownloadsChanged: refreshDlList });
