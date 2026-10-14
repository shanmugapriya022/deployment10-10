import React, { useState, useRef, useMemo, useEffect } from 'react';
import { Project, TestCase, TestStatus, TestScenario, TestType, TestIntent, TestPriority, isApiTestingScenario, isApiTestingCase, getTestCaseDisplayTitle, getTestCaseDisplayDescription, isGenericTestCaseTitle } from '../types';
import { downloadExcel, downloadCsv } from '../utils/exportUtils';
import { 
  Plus, 
  Upload, 
  Download, 
  FileSpreadsheet, 
  CheckCircle2, 
  Pencil, 
  Trash2, 
  X, 
  XCircle,
  Save, 
  Search, 
  FolderPlus, 
  FolderInput,
  LayoutGrid, 
  Folder, 
  ChevronDown, 
  ChevronUp, 
  Edit3, 
  AlertTriangle,
  CheckSquare,
  Square,
  BookOpen,
  Zap,
  FileText,
  Asterisk,
  Play,
  MinusCircle,
  Hash,
  Check,
  Loader2
} from 'lucide-react';
import { loadXlsxWorkbook, worksheetToJson } from '../utils/spreadsheetUtils';
import { toast } from 'sonner';
import { logActivity } from '../services/activityService';
import { generateUniqueFolderId } from '../utils/idGenerator';
import { deductExportCredits } from '../services/creditService';

interface ManualTestCaseManagerProps {
  project: Project;
  user: { email: string, name: string };
  onUpdateProject: (p: Project) => void;
  onRunFolder?: (folderId: string) => void;
  onNavigateTab?: (tab: string, meta?: { folderId: string; folderName: string }) => void;
}

interface ApproveScriptModalState {
  isOpen: boolean;
  targetType: 'single' | 'bulk';
  testCases: TestCase[];
  sourceTitle: string;
  
  // Functional Folder selection/creation (Move to Functional Folder)
  functionalFolderMode: 'existing' | 'new';
  selectedFunctionalFolderId: string;
  selectedFunctionalFolderName: string;
  newFunctionalFolderName: string;

  // Option to also send to Script Generator
  sendToScriptGenerator: boolean;
  scriptFolderMode: 'existing' | 'new';
  selectedScriptFolderId: string;
  selectedScriptFolderName: string;
  newScriptFolderName: string;
  newScriptFolderDescription?: string;
}

interface DeleteTarget {
  type: 'case' | 'folder' | 'bulk_cases';
  id?: string;
  folderId?: string;
  ids?: string[];
}

const ManualTestCaseManager: React.FC<ManualTestCaseManagerProps> = ({ project, user, onUpdateProject, onRunFolder, onNavigateTab }) => {
  const [activeTab, setActiveTab] = useState<'cases' | 'folders'>('cases');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set(['manual-root']));
  
  // Test Case Modal State
  const [isCaseModalOpen, setIsCaseModalOpen] = useState(false);
  const [editingCaseId, setEditingCaseId] = useState<string | null>(null);
  const [caseForm, setCaseForm] = useState<TestCase>({
    id: '',
    title: '',
    steps: [''],
    expectedResult: '',
    status: TestStatus.NOT_EXECUTED,
    isApproved: false,
    testType: TestType.FUNCTIONAL,
    testIntent: TestIntent.POSITIVE,
    priority: TestPriority.MEDIUM
  });
  const [caseErrors, setCaseErrors] = useState<Record<string, string>>({});

  // Folder Modal State
  const [isFolderModalOpen, setIsFolderModalOpen] = useState(false);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<string>>(new Set());
  const [folderError, setFolderError] = useState<string | null>(null);

  // Bulk Selection State for Individual Cases Tab
  const [bulkSelectedCaseIds, setBulkSelectedCaseIds] = useState<Set<string>>(new Set());

  // Move to Folder State
  const [isMoveToFolderModalOpen, setIsMoveToFolderModalOpen] = useState(false);
  const [casesToMove, setCasesToMove] = useState<TestCase[]>([]);
  const [moveFolderMode, setMoveFolderMode] = useState<'existing' | 'new'>('existing');
  const [moveTargetFolderId, setMoveTargetFolderId] = useState('');
  const [moveFolderNewName, setMoveFolderNewName] = useState('');
  const [moveFolderError, setMoveFolderError] = useState<string | null>(null);

  // Deletion State
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [isSavingCase, setIsSavingCase] = useState(false);

  // Script Generator Approval Modal State
  const [approveScriptModal, setApproveScriptModal] = useState<ApproveScriptModalState | null>(null);

  // Script Generator folders list (derived from automationFolders, script_generator scenario folders, and test cases)
  const scriptGeneratorFolders = useMemo(() => {
    const list: { id: string; name: string; count: number }[] = [];
    const seenNames = new Set<string>();

    (project.scenarios || []).forEach(s => {
      if (s.folderType === 'script_generator' || s.scenarioId === 'SCRIPT_GENERATOR_FOLDER' || s.moduleName === 'Script Generator') {
        const normName = (s.title || '').trim();
        if (normName && !seenNames.has(normName.toLowerCase())) {
          seenNames.add(normName.toLowerCase());
          list.push({ id: s.id, name: normName, count: (s.testCases || []).length });
        }
      }
    });

    (project.automationFolders || []).forEach(f => {
      const normName = (f.name || '').trim();
      if (normName && !seenNames.has(normName.toLowerCase())) {
        seenNames.add(normName.toLowerCase());
        const count = (project.automationScripts || []).filter(
          sc => (sc.folderName || '').trim().toLowerCase() === normName.toLowerCase() || sc.folderId === f.id
        ).length;
        list.push({ id: f.id, name: normName, count });
      }
    });

    return list;
  }, [project.scenarios, project.automationFolders, project.automationScripts]);

  const triggerApproveModal = (testCases: TestCase[], sourceTitle: string) => {
    if (!testCases || testCases.length === 0) {
      toast.info('No pending test cases to approve');
      return;
    }

    // Determine default functional folder
    const existingFolderId = testCases[0]?.folderId;
    const existingFolder = manualFolders.find(f => f.id === existingFolderId);

    const initialFunctionalMode = manualFolders.length > 0 ? 'existing' : 'new';
    const defaultFunctionalFolder = existingFolder || manualFolders[0];
    const defaultNewFunctionalName = testCases.length === 1
      ? `${(testCases[0].title || 'Approved Case').slice(0, 30).trim()} Folder`
      : 'Approved Functional Cases';

    // Determine default script generator folder
    const initialScriptMode = scriptGeneratorFolders.length > 0 ? 'existing' : 'new';
    const defaultScriptFolder = scriptGeneratorFolders[0];
    const defaultNewScriptName = testCases.length === 1
      ? `${(testCases[0].title || 'Functional Case').slice(0, 30).trim()} Scripts`
      : 'Functional Test Scripts';

    setApproveScriptModal({
      isOpen: true,
      targetType: testCases.length === 1 ? 'single' : 'bulk',
      testCases,
      sourceTitle,

      functionalFolderMode: initialFunctionalMode,
      selectedFunctionalFolderId: defaultFunctionalFolder ? defaultFunctionalFolder.id : '',
      selectedFunctionalFolderName: defaultFunctionalFolder ? defaultFunctionalFolder.title : '',
      newFunctionalFolderName: defaultNewFunctionalName,

      sendToScriptGenerator: true,
      scriptFolderMode: initialScriptMode,
      selectedScriptFolderId: defaultScriptFolder ? defaultScriptFolder.id : '',
      selectedScriptFolderName: defaultScriptFolder ? defaultScriptFolder.name : '',
      newScriptFolderName: defaultNewScriptName,
      newScriptFolderDescription: ''
    });
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  // Helper to determine if a case originated from AI Scenarios or AI Test Cases
  const isAiScenarioOrTestCase = (c: TestCase, scenariosList: TestScenario[] = project.scenarios || []) => {
    if (!c) return false;
    // Explicit manual or uploaded cases are NEVER AI Scenarios
    if ((c as any).isManual || (c as any).isUploaded) return false;
    if (c.testCaseId && (c.testCaseId.startsWith('TC-MAN-') || c.testCaseId.startsWith('TC-MAN-UP-'))) return false;
    if (c.id && (c.id.startsWith('tc_man_') || c.id.startsWith('tc_man_up_'))) return false;

    // Folders created in manual testing or script generator are NEVER AI scenarios
    if (c.scenarioId === 'MANUAL_FOLDER' || c.scenarioId === 'SCRIPT_GENERATOR_FOLDER') return false;

    // 1. Synthetic IDs generated from AI scenarios
    if (c.id?.startsWith('tc_approved_') || c.id?.startsWith('TC-AI-')) return true;
    if (c.testCaseId?.startsWith('TC-AI-')) return true;

    // 2. Check if scenarioId points to an explicit AI Scenario in scenariosList
    if (c.scenarioId && c.scenarioId !== 'MANUAL_FOLDER' && c.scenarioId !== 'SCRIPT_GENERATOR_FOLDER') {
      const isAiParent = scenariosList.some(s => s.id === c.scenarioId && s.scenarioId !== 'MANUAL_FOLDER' && s.scenarioId !== 'SCRIPT_GENERATOR_FOLDER');
      if (isAiParent) return true;
    }

    // 3. Check if the case matches an AI scenario or AI scenario testCase in project.scenarios (excluding MANUAL_FOLDER and SCRIPT_GENERATOR_FOLDER)
    const matchesAiScenario = scenariosList.some(s => {
      if (s.scenarioId === 'MANUAL_FOLDER' || s.scenarioId === 'SCRIPT_GENERATOR_FOLDER') return false;
      if (s.id === c.id) return true;
      if (s.testCases?.some(tc => tc.id === c.id)) return true;
      return false;
    });
    if (matchesAiScenario) return true;

    return false;
  };

  const manualCases = useMemo(() => 
    (project.manualTestCases || []).filter(c => !isApiTestingCase(c) && !isAiScenarioOrTestCase(c, project.scenarios)), 
    [project.manualTestCases, project.scenarios]
  );

  // Auto-clean any AI Scenarios / AI Test Cases that may have leaked, and sanitize any generic "Uploaded Functional Testcase" titles
  useEffect(() => {
    const rawManualCases = project.manualTestCases || [];
    let casesChanged = false;
    const cleanedManualCases = rawManualCases
      .filter(c => !isApiTestingCase(c) && !isAiScenarioOrTestCase(c, project.scenarios))
      .map(c => {
        const displayTitle = getTestCaseDisplayTitle(c);
        const isGenTitle = isGenericTestCaseTitle(c.title);
        const isGenDesc = isGenericTestCaseTitle(c.description || '');
        if (isGenTitle || isGenDesc) {
          casesChanged = true;
          return {
            ...c,
            title: isGenTitle ? displayTitle : c.title,
            description: isGenDesc ? (c.description ? displayTitle : (c.expectedResult || '')) : (c.description || displayTitle)
          };
        }
        return c;
      });
    
    // Also clean up any MANUAL_FOLDER scenarios that might have had AI cases added to them or have generic testcase titles
    let foldersChanged = false;
    const updatedScenarios = (project.scenarios || []).map(s => {
      if (s.scenarioId === 'MANUAL_FOLDER') {
        const filteredCases = (s.testCases || []).filter(tc => !isApiTestingCase(tc) && !isAiScenarioOrTestCase(tc, project.scenarios));
        let folderCasesCleaned = false;
        const cleanedFolderCases = filteredCases.map(tc => {
          const displayTitle = getTestCaseDisplayTitle(tc);
          const isGenTitle = isGenericTestCaseTitle(tc.title);
          const isGenDesc = isGenericTestCaseTitle(tc.description || '');
          if (isGenTitle || isGenDesc) {
            folderCasesCleaned = true;
            return {
              ...tc,
              title: isGenTitle ? displayTitle : tc.title,
              description: isGenDesc ? (tc.description ? displayTitle : (tc.expectedResult || '')) : (tc.description || displayTitle)
            };
          }
          return tc;
        });

        if (filteredCases.length !== (s.testCases || []).length || folderCasesCleaned) {
          foldersChanged = true;
          return {
            ...s,
            testCases: cleanedFolderCases,
            memberScenarioIds: (s.memberScenarioIds || []).filter(id => cleanedFolderCases.some(tc => tc.id === id))
          };
        }
      }
      return s;
    });

    if (cleanedManualCases.length !== rawManualCases.length || casesChanged || foldersChanged) {
      const updatedProject = {
        ...project,
        manualTestCases: cleanedManualCases,
        scenarios: updatedScenarios
      };
      try {
        localStorage.setItem(`automatiqa_project_backup_${project.id}`, JSON.stringify(updatedProject));
      } catch (e) {}
      onUpdateProject(updatedProject);
    }
  }, [project.scenarios, project.manualTestCases]);

  // Set of all test cases that have already been moved/assigned to any folder
  const folderAssignedCaseIds = useMemo(() => {
    const ids = new Set<string>();
    (project.scenarios || []).forEach(s => {
      if (s.scenarioId === 'MANUAL_FOLDER') {
        (s.testCases || []).forEach(tc => ids.add(tc.id));
        (s.memberScenarioIds || []).forEach(id => ids.add(id));
      }
    });
    manualCases.forEach(c => {
      if ((c as any).folderId || (c as any).isRemovedFromIndividual) {
        ids.add(c.id);
      }
    });
    return ids;
  }, [project.scenarios, manualCases]);

  // Test cases available for selection in the Add/Edit Folder Modal
  const availableCasesForFolderModal = useMemo(() => {
    if (editingFolderId) {
      // When editing an existing folder, include its current test cases + any unassigned test cases
      const otherFolderCaseIds = new Set<string>();
      (project.scenarios || []).forEach(s => {
        if (s.scenarioId === 'MANUAL_FOLDER' && s.id !== editingFolderId) {
          (s.testCases || []).forEach(tc => otherFolderCaseIds.add(tc.id));
          (s.memberScenarioIds || []).forEach(id => otherFolderCaseIds.add(id));
        }
      });
      return manualCases.filter(c => {
        const inOtherFolder = otherFolderCaseIds.has(c.id) || ((c as any).folderId && (c as any).folderId !== editingFolderId);
        return !inOtherFolder;
      });
    }
    // When adding a new folder, ONLY show test cases that are not yet moved to any folder
    return manualCases.filter(c => !folderAssignedCaseIds.has(c.id));
  }, [manualCases, folderAssignedCaseIds, editingFolderId, project.scenarios]);

  // Filtered lists
  const filteredCases = useMemo(() => {
    const unorganized = manualCases.filter(c => 
      !folderAssignedCaseIds.has(c.id) && !(c as any).folderId && !(c as any).isRemovedFromIndividual
    );

    if (!searchQuery.trim()) return unorganized;
    const query = searchQuery.toLowerCase();
    return unorganized.filter(c => 
      (c.testCaseId || '').toLowerCase().includes(query) ||
      c.title.toLowerCase().includes(query) || 
      c.description?.toLowerCase().includes(query) ||
      c.expectedResult.toLowerCase().includes(query)
    );
  }, [manualCases, searchQuery, folderAssignedCaseIds]);

  const unorganizedCasesCount = useMemo(() => {
    return manualCases.filter(c => 
      !folderAssignedCaseIds.has(c.id) && !(c as any).folderId && !(c as any).isRemovedFromIndividual
    ).length;
  }, [manualCases, folderAssignedCaseIds]);

  const manualFolders = useMemo(() => {
    return (project.scenarios || []).filter(s => s.scenarioId === 'MANUAL_FOLDER' && !isApiTestingScenario(s));
  }, [project.scenarios]);

  const filteredFolders = useMemo(() => {
    let base = manualFolders;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      base = manualFolders.filter(f => 
        f.title.toLowerCase().includes(query) ||
        (f.testCases || []).some(tc => 
          (tc.testCaseId || '').toLowerCase().includes(query) ||
          tc.title.toLowerCase().includes(query) ||
          tc.description?.toLowerCase().includes(query) ||
          tc.expectedResult.toLowerCase().includes(query) ||
          (tc.steps || []).some(s => s.toLowerCase().includes(query))
        )
      );
    }
    return base;
  }, [manualFolders, searchQuery]);

  const toggleExpand = (id: string) => {
    const next = new Set(expandedItems);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedItems(next);
  };

  const handleOpenAddCase = () => {
    setEditingCaseId(null);
    setCaseForm({
      id: Math.random().toString(36).substr(2, 9),
      testCaseId: `TC-MAN-${Date.now().toString().slice(-6)}`,
      title: '',
      steps: [''],
      expectedResult: '',
      status: TestStatus.NOT_EXECUTED,
      isApproved: false,
      testType: TestType.FUNCTIONAL,
      testIntent: TestIntent.POSITIVE,
      priority: TestPriority.MEDIUM
    });
    setCaseErrors({});
    setIsCaseModalOpen(true);
  };

  const getExecutionClassBadge = (testType?: string) => {
    const raw = String(testType || '').toLowerCase();
    if (raw.includes('non')) {
      return {
        label: 'Non-Functional',
        className: 'bg-purple-50 text-purple-700 border-purple-200'
      };
    }
    if (raw.includes('ui')) {
      return {
        label: 'UI',
        className: 'bg-pink-50 text-pink-700 border-pink-200'
      };
    }
    return {
      label: 'Functional',
      className: 'bg-indigo-50 text-indigo-700 border-indigo-200'
    };
  };

  const handleOpenEditCase = (tc: TestCase, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setEditingCaseId(tc.id);
    
    // Normalize testType so it reliably matches the select options
    const rawType = String(tc.testType || '').toLowerCase();
    let initialType = TestType.FUNCTIONAL;
    if (rawType.includes('non')) {
      initialType = TestType.NON_FUNCTIONAL;
    } else if (rawType.includes('ui')) {
      initialType = TestType.UI;
    }

    setCaseForm({ 
      ...tc,
      testType: initialType
    });
    setCaseErrors({});
    setIsCaseModalOpen(true);
  };

  const unapprovedCases = useMemo(() => {
    return filteredCases.filter(c => !c.isApproved);
  }, [filteredCases]);

  const allFilteredSelected = useMemo(() => {
    return filteredCases.length > 0 && filteredCases.every(c => bulkSelectedCaseIds.has(c.id));
  }, [filteredCases, bulkSelectedCaseIds]);

  const handleToggleSelectAll = () => {
    if (allFilteredSelected) {
      setBulkSelectedCaseIds(new Set());
    } else {
      setBulkSelectedCaseIds(new Set(filteredCases.map(c => c.id)));
    }
  };

  const handleToggleSelectCase = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setBulkSelectedCaseIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleBulkApprove = (targetIds?: string[]) => {
    const idsSet = new Set(
      targetIds && targetIds.length > 0 
        ? targetIds 
        : (bulkSelectedCaseIds.size > 0 ? Array.from(bulkSelectedCaseIds) : unapprovedCases.map(c => c.id))
    );

    const pendingCases = manualCases.filter(c => idsSet.has(c.id) && !c.isApproved);
    if (pendingCases.length === 0) {
      toast.info('No pending test cases selected for approval');
      return;
    }

    triggerApproveModal(pendingCases, `Bulk Approval (${pendingCases.length} Cases)`);
  };

  const handleApproveCase = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const targetCase = manualCases.find(c => c.id === id);
    if (!targetCase) {
      for (const s of project.scenarios || []) {
        const match = s.testCases?.find(tc => tc.id === id);
        if (match) {
          if (match.isApproved) {
            toast.info('Test case is already approved');
            return;
          }
          triggerApproveModal([match], match.title || 'Functional Test Case');
          return;
        }
      }
      return;
    }

    if (targetCase.isApproved) {
      toast.info('Test case is already approved');
      return;
    }

    triggerApproveModal([targetCase], targetCase.title || 'Functional Test Case');
  };

  const handleConfirmApproveToScriptGenerator = async () => {
    if (!approveScriptModal) return;
    const {
      testCases,
      functionalFolderMode,
      selectedFunctionalFolderId,
      selectedFunctionalFolderName,
      newFunctionalFolderName,
      sendToScriptGenerator,
      scriptFolderMode,
      selectedScriptFolderId,
      selectedScriptFolderName,
      newScriptFolderName,
      newScriptFolderDescription
    } = approveScriptModal;

    if (!testCases || testCases.length === 0) {
      toast.error('No test cases selected for approval');
      setApproveScriptModal(null);
      return;
    }

    // 1. Resolve Functional Folder
    let finalFunctionalFolderId = '';
    let finalFunctionalFolderName = '';

    if (functionalFolderMode === 'new') {
      const trimmedName = newFunctionalFolderName.trim();
      if (!trimmedName) {
        toast.error('Please enter a Functional Folder name');
        return;
      }
      finalFunctionalFolderName = trimmedName;
      const existingFolder = manualFolders.find(
        f => f.title.trim().toLowerCase() === trimmedName.toLowerCase()
      );
      finalFunctionalFolderId = existingFolder ? existingFolder.id : generateUniqueFolderId('manual_folder');
    } else {
      if (!selectedFunctionalFolderId && !selectedFunctionalFolderName) {
        toast.error('Please select an existing Functional Folder');
        return;
      }
      const matched = manualFolders.find(
        f => f.id === selectedFunctionalFolderId || f.title.toLowerCase() === (selectedFunctionalFolderName || '').toLowerCase()
      );
      if (matched) {
        finalFunctionalFolderId = matched.id;
        finalFunctionalFolderName = matched.title;
      } else {
        finalFunctionalFolderId = selectedFunctionalFolderId || generateUniqueFolderId('manual_folder');
        finalFunctionalFolderName = selectedFunctionalFolderName || 'Approved Functional Cases';
      }
    }

    // 2. Resolve Script Generator Folder if sendToScriptGenerator is true
    let finalScriptFolderId = '';
    let finalScriptFolderName = '';

    if (sendToScriptGenerator) {
      if (scriptFolderMode === 'new') {
        const trimmedName = newScriptFolderName.trim();
        if (!trimmedName) {
          toast.error('Please enter a folder name for Script Generator');
          return;
        }
        finalScriptFolderName = trimmedName;
        const existingInAuto = (project.automationFolders || []).find(
          f => f.name.trim().toLowerCase() === trimmedName.toLowerCase()
        );
        finalScriptFolderId = existingInAuto ? existingInAuto.id : generateUniqueFolderId('sg-folder');
      } else {
        if (!selectedScriptFolderId && !selectedScriptFolderName) {
          toast.error('Please select an existing Script Generator folder');
          return;
        }
        const matched = scriptGeneratorFolders.find(
          f => f.id === selectedScriptFolderId || f.name.toLowerCase() === (selectedScriptFolderName || '').toLowerCase()
        );
        if (matched) {
          finalScriptFolderId = matched.id;
          finalScriptFolderName = matched.name;
        } else {
          finalScriptFolderId = selectedScriptFolderId || generateUniqueFolderId('sg-folder');
          finalScriptFolderName = selectedScriptFolderName || 'Functional Scripts';
        }
      }
    }

    const approvingCaseIdSet = new Set(testCases.map(c => c.id));

    // Prepare updated test cases with folderId and approval flags
    const updatedTestCasesMap = new Map<string, TestCase>();
    testCases.forEach(c => {
      updatedTestCasesMap.set(c.id, {
        ...c,
        isApproved: true,
        folderId: finalFunctionalFolderId,
        isRemovedFromIndividual: true,
        saved: true,
        ...(sendToScriptGenerator ? {
          scriptGeneratorFolderId: finalScriptFolderId,
          scriptGeneratorFolderName: finalScriptFolderName
        } : {})
      });
    });

    // Update manualTestCases array
    const updatedManualCases = (project.manualTestCases || []).map(c => {
      if (approvingCaseIdSet.has(c.id)) {
        return updatedTestCasesMap.get(c.id)!;
      }
      return c;
    });

    // Update or Create Functional Folder (`MANUAL_FOLDER`) scenario in project.scenarios
    let updatedScenarios = [...(project.scenarios || [])];

    const existingFunctionalIdx = updatedScenarios.findIndex(
      s => s.scenarioId === 'MANUAL_FOLDER' && (s.id === finalFunctionalFolderId || s.title.trim().toLowerCase() === finalFunctionalFolderName.toLowerCase())
    );

    const approvedCasesList = Array.from(updatedTestCasesMap.values());

    if (existingFunctionalIdx >= 0) {
      const targetFolder = updatedScenarios[existingFunctionalIdx];
      const existingCasesMap = new Map<string, TestCase>();
      (targetFolder.testCases || []).forEach(tc => existingCasesMap.set(tc.id, tc));
      approvedCasesList.forEach(tc => existingCasesMap.set(tc.id, tc));
      const combinedMemberIds = Array.from(new Set([
        ...(targetFolder.memberScenarioIds || []),
        ...Array.from(approvingCaseIdSet)
      ]));

      updatedScenarios[existingFunctionalIdx] = {
        ...targetFolder,
        id: finalFunctionalFolderId,
        title: finalFunctionalFolderName,
        isApproved: true,
        testCases: Array.from(existingCasesMap.values()),
        memberScenarioIds: combinedMemberIds,
        saved: true
      };
    } else {
      const newFunctionalFolderScenario: TestScenario = {
        id: finalFunctionalFolderId,
        scenarioId: 'MANUAL_FOLDER',
        title: finalFunctionalFolderName,
        description: `Functional Folder: ${finalFunctionalFolderName}`,
        expectedResults: 'Execution validates requirements successfully.',
        type: 'Functional',
        isFolder: true,
        folderType: 'manual',
        isApproved: true,
        testCases: approvedCasesList,
        memberScenarioIds: Array.from(approvingCaseIdSet),
        moduleName: 'Functional Folders',
        saved: true,
        createdAt: new Date().toISOString()
      };
      updatedScenarios.unshift(newFunctionalFolderScenario);
    }

    // Also update existing MANUAL_FOLDER testCases across other folders if present
    updatedScenarios = updatedScenarios.map(s => {
      if (s.scenarioId === 'MANUAL_FOLDER' && s.id !== finalFunctionalFolderId) {
        return {
          ...s,
          testCases: (s.testCases || []).map(tc => {
            if (approvingCaseIdSet.has(tc.id)) {
              return updatedTestCasesMap.get(tc.id)!;
            }
            return tc;
          })
        };
      }
      return s;
    });

    // If sendToScriptGenerator is true, ensure Script Generator folder scenario exists in project.scenarios
    if (sendToScriptGenerator) {
      const existingSgIdx = updatedScenarios.findIndex(
        s => (s.folderType === 'script_generator' || s.scenarioId === 'SCRIPT_GENERATOR_FOLDER') &&
             (s.id === finalScriptFolderId || s.title.trim().toLowerCase() === finalScriptFolderName.toLowerCase())
      );

      if (existingSgIdx >= 0) {
        const targetFolder = updatedScenarios[existingSgIdx];
        const existingCasesMap = new Map<string, TestCase>();
        (targetFolder.testCases || []).forEach(tc => existingCasesMap.set(tc.id, tc));
        approvedCasesList.forEach(tc => existingCasesMap.set(tc.id, tc));
        updatedScenarios[existingSgIdx] = {
          ...targetFolder,
          isApproved: true,
          testCases: Array.from(existingCasesMap.values()),
          saved: true
        };
      } else {
        const newSgFolderScenario: TestScenario = {
          id: finalScriptFolderId,
          scenarioId: 'SCRIPT_GENERATOR_FOLDER',
          title: finalScriptFolderName,
          description: newScriptFolderDescription?.trim() || `Script Generator Folder: ${finalScriptFolderName}`,
          expectedResults: 'Execution validates requirements successfully.',
          type: 'Functional',
          isFolder: true,
          folderType: 'script_generator',
          isApproved: true,
          testCases: approvedCasesList,
          moduleName: 'Script Generator',
          saved: true,
          createdAt: new Date().toISOString()
        };
        updatedScenarios.push(newSgFolderScenario);
      }
    }

    const updatedProject: Project = {
      ...project,
      manualTestCases: updatedManualCases,
      scenarios: updatedScenarios
    };

    try {
      localStorage.setItem(`automatiqa_project_backup_${project.id}`, JSON.stringify(updatedProject));
    } catch (e) {}

    onUpdateProject(updatedProject);
    setBulkSelectedCaseIds(new Set());
    setApproveScriptModal(null);

    if (sendToScriptGenerator) {
      toast.success(`Approved ${testCases.length} test case(s), moved to Functional Folder "${finalFunctionalFolderName}", and saved to Script Generator folder "${finalScriptFolderName}"!`);
      try {
        await logActivity(user.email, user.name, `Approved ${testCases.length} Functional Test Cases into Functional Folder (${finalFunctionalFolderName}) & Script Generator (${finalScriptFolderName})`, project.id, project.name);
      } catch (e) {}

      if (onNavigateTab) {
        onNavigateTab('scripts', { folderId: finalScriptFolderId, folderName: finalScriptFolderName });
      }
    } else {
      setActiveTab('folders');
      toast.success(`Approved ${testCases.length} test case(s) and moved to Functional Folder "${finalFunctionalFolderName}"!`);
      try {
        await logActivity(user.email, user.name, `Approved ${testCases.length} Functional Test Cases into Functional Folder: ${finalFunctionalFolderName}`, project.id, project.name);
      } catch (e) {}
    }
  };

  const validateCase = () => {
    const errors: Record<string, string> = {};
    if (!caseForm.title || !caseForm.title.trim()) {
      errors.title = "Test Case Name is required";
      toast.error("Please enter a Test Case Name");
    }
    setCaseErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSaveTestCase = async () => {
    if (!validateCase()) return;
    setIsSavingCase(true);

    try {
      const validSteps = (caseForm.steps || []).filter(s => s && s.trim() !== '');
      const finalSteps = validSteps.length > 0 
        ? validSteps 
        : [`1. Execute test procedure for ${caseForm.title.trim()}`];

      const finalExpectedResult = (caseForm.expectedResult && caseForm.expectedResult.trim())
        ? caseForm.expectedResult.trim()
        : `Verify that ${caseForm.title.trim()} executes successfully without errors.`;

      const rawTestType = String(caseForm.testType || '').toLowerCase();
      let resolvedTestType = TestType.FUNCTIONAL;
      if (rawTestType.includes('non')) {
        resolvedTestType = TestType.NON_FUNCTIONAL;
      } else if (rawTestType.includes('ui')) {
        resolvedTestType = TestType.UI;
      }

      const finalCase: TestCase = {
        ...caseForm,
        id: caseForm.id || `tc_man_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        testCaseId: caseForm.testCaseId || `TC-MAN-${Date.now().toString().slice(-6)}`,
        title: caseForm.title.trim(),
        steps: finalSteps,
        expectedResult: finalExpectedResult,
        status: caseForm.status || TestStatus.NOT_EXECUTED,
        isApproved: Boolean(caseForm.isApproved),
        testType: resolvedTestType,
        testIntent: caseForm.testIntent || TestIntent.POSITIVE,
        priority: caseForm.priority || TestPriority.MEDIUM
      };

      const currentManualCases = project.manualTestCases || [];
      let updatedCases: TestCase[];
      if (editingCaseId) {
        const exists = currentManualCases.some(c => c.id === editingCaseId);
        if (exists) {
          updatedCases = currentManualCases.map(c => c.id === editingCaseId ? finalCase : c);
        } else {
          updatedCases = [...currentManualCases, finalCase];
        }
      } else {
        updatedCases = [finalCase, ...currentManualCases];
      }

      // SYNC: Update the test case within all folders and scenarios safely
      const updatedScenarios = (project.scenarios || []).map(s => {
        if (Array.isArray(s.testCases) && s.testCases.some(tc => tc.id === editingCaseId)) {
          return {
            ...s,
            testCases: s.testCases.map(tc => tc.id === editingCaseId ? finalCase : tc)
          };
        }
        return s;
      });

      const updatedProject: Project = { 
        ...project, 
        manualTestCases: updatedCases, 
        scenarios: updatedScenarios 
      };

      // Save immediate local backup for survival across page reloads/refreshes
      try {
        localStorage.setItem(`automatiqa_project_backup_${project.id}`, JSON.stringify(updatedProject));
      } catch (e) {}

      onUpdateProject(updatedProject);
      
      toast.success(editingCaseId ? 'Functional Test Case updated successfully!' : 'Functional Test Case created successfully!');

      try {
        await logActivity(
          user.email, 
          user.name, 
          `${editingCaseId ? 'Updated' : 'Created'} Functional Test Case: ${finalCase.title}`, 
          project.id, 
          project.name
        );
      } catch (err) {
        console.warn('logActivity err:', err);
      }

      setIsCaseModalOpen(false);
    } catch (err: any) {
      console.error('Save test case error:', err);
      toast.error('Failed to save test case: ' + (err?.message || 'Error occurred'));
    } finally {
      setIsSavingCase(false);
    }
  };

  const triggerDeleteCase = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget({ type: 'case', id });
  };

  const triggerDeleteFolder = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget({ type: 'folder', id });
  };

  const handleRemoveFromFolder = (folderId: string, caseId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updatedScenarios = project.scenarios.map(s => {
      if (s.id === folderId) {
        return {
          ...s,
          testCases: s.testCases.filter(tc => tc.id !== caseId),
          memberScenarioIds: (s.memberScenarioIds || []).filter(id => id !== caseId)
        };
      }
      return s;
    });
    // Check if this case is in any other folder
    const stillInAnotherFolder = updatedScenarios.some(s => s.scenarioId === 'MANUAL_FOLDER' && s.testCases?.some(tc => tc.id === caseId));
    const currentList = project.manualTestCases || [];
    const updatedManualCases = currentList.map(c => {
      if (c.id === caseId && !stillInAnotherFolder) {
        const { folderId: _, isRemovedFromIndividual: __, saved: ___, ...rest } = c as any;
        return rest;
      }
      return c;
    });
    onUpdateProject({ ...project, scenarios: updatedScenarios, manualTestCases: updatedManualCases });
  };

  const executeDeletion = () => {
    if (!deleteTarget) return;
    if (deleteTarget.type === 'bulk_cases') {
      const idsToDelete = new Set(deleteTarget.ids || Array.from(bulkSelectedCaseIds));
      if (idsToDelete.size === 0) {
        setDeleteTarget(null);
        return;
      }
      const count = idsToDelete.size;
      const currentList = project.manualTestCases || [];
      const updated = currentList.filter(c => !idsToDelete.has(c.id));
      
      // SCRUB: Remove from all folders too
      const updatedScenarios = (project.scenarios || []).map(s => {
        if (s.scenarioId === 'MANUAL_FOLDER') {
          return {
            ...s,
            testCases: (s.testCases || []).filter(tc => !idsToDelete.has(tc.id)),
            memberScenarioIds: (s.memberScenarioIds || []).filter(id => !idsToDelete.has(id))
          };
        }
        return s;
      });

      const updatedProject: Project = { ...project, manualTestCases: updated, scenarios: updatedScenarios };
      try {
        localStorage.setItem(`automatiqa_project_backup_${project.id}`, JSON.stringify(updatedProject));
      } catch (e) {}

      onUpdateProject(updatedProject);
      setBulkSelectedCaseIds(new Set());
      toast.success(`Successfully deleted ${count} test case${count > 1 ? 's' : ''}`);
      try {
        logActivity(user.email, user.name, `Bulk deleted ${count} Functional Test Cases`, project.id, project.name);
      } catch (e) {}
      setDeleteTarget(null);
      return;
    }

    if (deleteTarget.type === 'case') {
      const currentList = project.manualTestCases || [];
      const updated = currentList.filter(c => c.id !== deleteTarget.id);
      
      // SCRUB: Remove from all folders too
      const updatedScenarios = (project.scenarios || []).map(s => {
        if (s.scenarioId === 'MANUAL_FOLDER') {
          return {
            ...s,
            testCases: s.testCases.filter(tc => tc.id !== deleteTarget.id),
            memberScenarioIds: (s.memberScenarioIds || []).filter(id => id !== deleteTarget.id)
          };
        }
        return s;
      });

      onUpdateProject({ ...project, manualTestCases: updated, scenarios: updatedScenarios });
    } else {
      const folderId = deleteTarget.id;
      const updatedScenarios = project.scenarios.filter(s => s.id !== folderId);
      // Reset folderId on manualTestCases that belonged to this folder (if not in other folders)
      const remainingFolderCaseIds = new Set<string>();
      updatedScenarios.forEach(s => {
        if (s.scenarioId === 'MANUAL_FOLDER') {
          (s.testCases || []).forEach(tc => remainingFolderCaseIds.add(tc.id));
          (s.memberScenarioIds || []).forEach(id => remainingFolderCaseIds.add(id));
        }
      });
      const currentList = project.manualTestCases || [];
      const updatedManualCases = currentList.map(c => {
        if (!remainingFolderCaseIds.has(c.id)) {
          const { folderId: _, isRemovedFromIndividual: __, saved: ___, ...rest } = c as any;
          return rest;
        }
        return c;
      });
      onUpdateProject({ ...project, scenarios: updatedScenarios, manualTestCases: updatedManualCases });
    }
    setDeleteTarget(null);
  };

  const openFolderModal = (folder?: TestScenario) => {
    setFolderError(null);
    if (folder) {
      setEditingFolderId(folder.id);
      setNewFolderName(folder.title);
      const preselected = new Set<string>();
      (folder.testCases || []).forEach(folderCase => {
        const match = manualCases.find(mc => mc.id === folderCase.id);
        if (match) preselected.add(match.id);
      });
      setSelectedCaseIds(preselected);
    } else {
      setEditingFolderId(null);
      setNewFolderName('');
      setSelectedCaseIds(new Set());
    }
    setIsFolderModalOpen(true);
  };

  const handleSelectAllInModal = () => {
    setFolderError(null);
    if (selectedCaseIds.size === availableCasesForFolderModal.length && availableCasesForFolderModal.length > 0) {
      setSelectedCaseIds(new Set());
    } else {
      setSelectedCaseIds(new Set(availableCasesForFolderModal.map(c => c.id)));
    }
  };

  const handleSaveFolder = async () => {
    const trimmedName = newFolderName.trim();
    if (!trimmedName) {
      setFolderError("Please enter a folder name.");
      return;
    }

    const isDuplicate = project.scenarios.some(s => 
      s.scenarioId === 'MANUAL_FOLDER' && 
      s.id !== editingFolderId &&
      s.title.toLowerCase() === trimmedName.toLowerCase()
    );

    if (isDuplicate) {
      setFolderError('This folder name is already in use.');
      return;
    }

    if (selectedCaseIds.size === 0) {
      setFolderError("Please select at least one test case.");
      return;
    }

    const selectedCases: TestCase[] = manualCases.filter(c => selectedCaseIds.has(c.id)).map(c => {
      const displayTitle = getTestCaseDisplayTitle(c);
      const isGenTitle = isGenericTestCaseTitle(c.title);
      const isGenDesc = isGenericTestCaseTitle(c.description || '');
      return {
        ...c,
        title: isGenTitle ? displayTitle : c.title,
        description: isGenDesc ? (c.description ? displayTitle : (c.expectedResult || '')) : (c.description || displayTitle)
      };
    });
    const targetFolderId = editingFolderId || generateUniqueFolderId('manual_folder');

    let updatedScenarios = [...(project.scenarios || [])];
    if (editingFolderId) {
      updatedScenarios = updatedScenarios.map(s => 
        s.id === editingFolderId ? { 
          ...s, 
          title: trimmedName, 
          testCases: selectedCases,
          memberScenarioIds: Array.from(selectedCaseIds)
        } : s
      );
    } else {
      const folderScenario: TestScenario = {
        id: targetFolderId,
        scenarioId: 'MANUAL_FOLDER',
        title: trimmedName,
        type: 'Functional',
        description: `Functional folder with ${selectedCases.length} test cases.`,
        expectedResults: 'Group expectations.',
        moduleName: 'Functional Folders',
        isApproved: true,
        testCases: selectedCases,
        memberScenarioIds: Array.from(selectedCaseIds),
        createdAt: new Date().toISOString()
      };
      updatedScenarios = [folderScenario, ...updatedScenarios];
    }

    // Update manualTestCases to mark them as saved inside this folder and remove from individual view
    const currentList = project.manualTestCases || [];
    const updatedManualCases = currentList.map(c => {
      if (selectedCaseIds.has(c.id)) {
        return {
          ...c,
          folderId: targetFolderId,
          isRemovedFromIndividual: true,
          saved: true
        };
      } else if (editingFolderId && (c as any).folderId === editingFolderId) {
        // If it was previously in this folder but deselected
        const { folderId: _, isRemovedFromIndividual: __, saved: ___, ...rest } = c as any;
        return rest;
      }
      return c;
    });

    try {
      await Promise.resolve(onUpdateProject({ ...project, scenarios: updatedScenarios, manualTestCases: updatedManualCases }));
    } catch (err) {
      toast.error('Could not save the functional test case folder. Please try again.');
      return;
    }

    setIsFolderModalOpen(false);
    setNewFolderName('');
    setSelectedCaseIds(new Set());
    setEditingFolderId(null);
    setFolderError(null);
    setActiveTab('folders');

    try {
      await logActivity(user.email, user.name, `${editingFolderId ? 'Updated' : 'Created'} Functional Folder: ${trimmedName}`, project.id, project.name);
    } catch (e) {
      console.warn('Failed to log activity:', e);
    }
  };

  const handleOpenBulkMoveToFolder = () => {
    if (bulkSelectedCaseIds.size === 0) {
      toast.error('Please select at least one test case to move');
      return;
    }
    const targetCases = manualCases.filter(c => bulkSelectedCaseIds.has(c.id));
    setCasesToMove(targetCases);
    setMoveFolderMode(manualFolders.length > 0 ? 'existing' : 'new');
    setMoveTargetFolderId(manualFolders.length > 0 ? manualFolders[0].id : '');
    setMoveFolderNewName('');
    setMoveFolderError(null);
    setIsMoveToFolderModalOpen(true);
  };

  const handleOpenSingleMoveToFolder = (tc: TestCase, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    setCasesToMove([tc]);
    setMoveFolderMode(manualFolders.length > 0 ? 'existing' : 'new');
    setMoveTargetFolderId(manualFolders.length > 0 ? manualFolders[0].id : '');
    setMoveFolderNewName('');
    setMoveFolderError(null);
    setIsMoveToFolderModalOpen(true);
  };

  const handleConfirmMoveToFolder = async () => {
    if (casesToMove.length === 0) {
      setMoveFolderError('No test cases selected to move.');
      return;
    }

    const movingIds = new Set(casesToMove.map(c => c.id));
    let targetFolderId = moveTargetFolderId;
    let targetFolderName = '';

    if (moveFolderMode === 'existing') {
      if (!targetFolderId) {
        setMoveFolderError('Please select a destination folder.');
        return;
      }
      const existingFolder = manualFolders.find(f => f.id === targetFolderId);
      if (!existingFolder) {
        setMoveFolderError('Selected folder not found.');
        return;
      }
      targetFolderName = existingFolder.title;
    } else {
      const trimmedName = moveFolderNewName.trim();
      if (!trimmedName) {
        setMoveFolderError('Please enter a folder name.');
        return;
      }
      const isDuplicate = manualFolders.some(f => f.title.toLowerCase() === trimmedName.toLowerCase());
      if (isDuplicate) {
        setMoveFolderError('A folder with this name already exists.');
        return;
      }
      targetFolderId = generateUniqueFolderId('manual_folder');
      targetFolderName = trimmedName;
    }

    const sanitizedCasesToMove = casesToMove.map(c => {
      const displayTitle = getTestCaseDisplayTitle(c);
      const isGenTitle = isGenericTestCaseTitle(c.title);
      const isGenDesc = isGenericTestCaseTitle(c.description || '');
      return {
        ...c,
        title: isGenTitle ? displayTitle : c.title,
        description: isGenDesc ? (c.description ? displayTitle : (c.expectedResult || '')) : (c.description || displayTitle)
      };
    });

    let updatedScenarios = [...(project.scenarios || [])];

    if (moveFolderMode === 'existing') {
      updatedScenarios = updatedScenarios.map(s => {
        if (s.id === targetFolderId && s.scenarioId === 'MANUAL_FOLDER') {
          const currentCases = s.testCases || [];
          const currentCaseIds = new Set(currentCases.map(c => c.id));
          const newCasesToAdd = sanitizedCasesToMove.filter(c => !currentCaseIds.has(c.id));
          const combinedCases = [...currentCases, ...newCasesToAdd];
          const currentMemberIds = s.memberScenarioIds || [];
          const combinedMemberIds = Array.from(new Set([...currentMemberIds, ...Array.from(movingIds)]));

          return {
            ...s,
            testCases: combinedCases,
            memberScenarioIds: combinedMemberIds
          };
        }
        return s;
      });
    } else {
      const newFolder: TestScenario = {
        id: targetFolderId,
        scenarioId: 'MANUAL_FOLDER',
        title: targetFolderName,
        type: 'Functional',
        description: `Functional folder with ${sanitizedCasesToMove.length} test cases.`,
        expectedResults: 'Group expectations.',
        moduleName: 'Functional Folders',
        isApproved: true,
        testCases: sanitizedCasesToMove,
        memberScenarioIds: Array.from(movingIds),
        createdAt: new Date().toISOString()
      };
      updatedScenarios = [newFolder, ...updatedScenarios];
    }

    // Update manualTestCases to mark them as moved inside this folder and removed from individual view
    const currentList = project.manualTestCases || [];
    const updatedManualCases = currentList.map(c => {
      if (movingIds.has(c.id)) {
        return {
          ...c,
          folderId: targetFolderId,
          isRemovedFromIndividual: true,
          saved: true
        };
      }
      return c;
    });

    // Close modal, clear selections
    setIsMoveToFolderModalOpen(false);
    setCasesToMove([]);
    setBulkSelectedCaseIds(new Set());
    setMoveFolderError(null);

    const updatedProject = {
      ...project,
      scenarios: updatedScenarios,
      manualTestCases: updatedManualCases
    };

    onUpdateProject(updatedProject);
    try {
      localStorage.setItem(`automatiqa_project_backup_${project.id}`, JSON.stringify(updatedProject));
    } catch (e) {}

    toast.success(`Successfully moved ${casesToMove.length} test case(s) to folder "${targetFolderName}"`);
    try {
      await logActivity(
        user.email,
        user.name,
        `Moved ${casesToMove.length} test case(s) to folder "${targetFolderName}"`,
        project.id,
        project.name
      );
    } catch (e) {}
  };

  const handleDownloadExcel = async (format: 'excel' | 'csv' = 'excel') => {
    if (manualCases.length === 0) {
      toast.error('No functional test cases available to export');
      return;
    }
    if (!await deductExportCredits(project.id, 'ai_test_cases', user, `Download Functional Test Cases (${format.toUpperCase()})`, project.name)) return;

    const data = manualCases.map(tc => ({
      'Test Case ID': tc.testCaseId || 'N/A',
      Title: tc.title,
      Description: tc.description || '',
      Steps: tc.steps.join('\n'),
      ExpectedResult: tc.expectedResult,
      Type: tc.testType,
      Intent: tc.testIntent,
      Priority: tc.priority,
      Approved: tc.isApproved ? 'Yes' : 'No'
    }));

    const filename = `${project.name.replace(/\s+/g, '_')}_Functional_Cases`;
    if (format === 'excel') {
      downloadExcel(data, filename, "Functional Test Cases");
      toast.success(`Exported ${manualCases.length} functional cases to Excel`);
    } else {
      downloadCsv(data, filename);
      toast.success(`Exported ${manualCases.length} functional cases to CSV`);
    }
  };

  const handleDownloadTemplate = (format: 'excel' | 'csv' = 'excel') => {
    const templateData = [
      { 
        Title: 'Verify successful login with valid credentials', 
        TestType: 'Functional',
        Description: 'User should be able to log in using a registered email and password.',
        Steps: '1. Navigate to the login page\n2. Enter valid email\n3. Enter valid password\n4. Click login button',
        ExpectedResult: 'User should be redirected to the dashboard'
      }
    ];
    if (format === 'excel') {
      downloadExcel(templateData, 'Functional_Test_Case_Template', 'Functional Case Template');
      toast.success('Template downloaded as Excel');
    } else {
      downloadCsv(templateData, 'Functional_Test_Case_Template');
      toast.success('Template downloaded as CSV');
    }
  };

  const handleDownloadFolder = async (folder: { id: string, title: string, testCases: TestCase[] }, format: 'excel' | 'csv' = 'excel', e?: React.MouseEvent) => {
    if (e) e.stopPropagation();

    if (folder.testCases.length === 0) {
      toast.error(`Folder "${folder.title}" has no test cases to export`);
      return;
    }
    if (!await deductExportCredits(project.id, 'ai_test_cases', user, `Download Functional Test Case Folder (${format.toUpperCase()})`, project.name)) return;

    const data = folder.testCases.map((tc, idx) => ({
      '#': idx + 1,
      'Test Case ID': tc.testCaseId || `TC-${idx + 1}`,
      'Folder': folder.title,
      'Title': tc.title,
      'Description': tc.description || '',
      'Steps': tc.steps.join('\n'),
      'ExpectedResult': tc.expectedResult,
      'Type': tc.testType,
      'Intent': tc.testIntent,
      'Priority': tc.priority,
      'Approved': tc.isApproved ? 'Yes' : 'No'
    }));

    const safeTitle = folder.title.replace(/\s+/g, '_');
    const filename = `${safeTitle}_Functional_Cases`;
    if (format === 'excel') {
      downloadExcel(data, filename, folder.title.slice(0, 30));
      toast.success(`Exported ${folder.testCases.length} cases from "${folder.title}" to Excel`);
    } else {
      downloadCsv(data, filename);
      toast.success(`Exported ${folder.testCases.length} cases from "${folder.title}" to CSV`);
    }
  };

  const handleDownloadSingleCase = async (tc: TestCase, folderTitle: string, format: 'excel' | 'csv' = 'excel', e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!await deductExportCredits(project.id, 'ai_test_cases', user, `Download Functional Test Case (${format.toUpperCase()})`, project.name)) return;

    const data = [{
      'Test Case ID': tc.testCaseId || tc.id,
      'Folder': folderTitle,
      'Title': tc.title,
      'Description': tc.description || '',
      'Steps': tc.steps.join('\n'),
      'ExpectedResult': tc.expectedResult,
      'Type': tc.testType,
      'Intent': tc.testIntent,
      'Priority': tc.priority,
      'Approved': tc.isApproved ? 'Yes' : 'No'
    }];

    const safeId = (tc.testCaseId || 'TestCase').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${safeId}_Functional_Case`;
    if (format === 'excel') {
      downloadExcel(data, filename, 'Test Case');
      toast.success(`Test case ${tc.testCaseId || ''} exported to Excel`);
    } else {
      downloadCsv(data, filename);
      toast.success(`Test case ${tc.testCaseId || ''} exported to CSV`);
    }
  };

  const handleDownloadSelectedCases = async (format: 'excel' | 'csv' = 'excel') => {
    const selected = manualCases.filter(c => bulkSelectedCaseIds.has(c.id));
    if (selected.length === 0) {
      toast.error('No test cases selected for download');
      return;
    }
    if (!await deductExportCredits(project.id, 'ai_test_cases', user, `Download Selected Functional Test Cases (${format.toUpperCase()})`, project.name)) return;

    const data = selected.map((tc, idx) => ({
      '#': idx + 1,
      'Test Case ID': tc.testCaseId || `TC-${idx + 1}`,
      'Title': tc.title,
      'Description': tc.description || '',
      'Steps': tc.steps.join('\n'),
      'ExpectedResult': tc.expectedResult,
      'Type': tc.testType,
      'Intent': tc.testIntent,
      'Priority': tc.priority,
      'Approved': tc.isApproved ? 'Yes' : 'No'
    }));

    const filename = `${project.name.replace(/\s+/g, '_')}_Selected_Cases`;
    if (format === 'excel') {
      downloadExcel(data, filename, 'Selected Cases');
      toast.success(`Downloaded ${selected.length} cases as Excel`);
    } else {
      downloadCsv(data, filename);
      toast.success(`Downloaded ${selected.length} cases as CSV`);
    }
  };

  const parseRawCsvText = (text: string): any[] => {
    if (!text || !text.trim()) return [];
    const cleanText = text.replace(/^\uFEFF/, '').trim();
    const lines: string[] = [];
    let currentLine = '';
    let inQuotes = false;

    for (let i = 0; i < cleanText.length; i++) {
      const char = cleanText[i];
      if (char === '"') {
        inQuotes = !inQuotes;
        currentLine += char;
      } else if ((char === '\n' || char === '\r') && !inQuotes) {
        if (char === '\r' && cleanText[i + 1] === '\n') {
          i++;
        }
        if (currentLine.trim()) lines.push(currentLine);
        currentLine = '';
      } else {
        currentLine += char;
      }
    }
    if (currentLine.trim()) lines.push(currentLine);

    if (lines.length < 2) return [];

    const headerLine = lines[0];
    let delimiter = ',';
    if (headerLine.includes('\t')) delimiter = '\t';
    else if (headerLine.includes(';') && !headerLine.includes(',')) delimiter = ';';

    const parseLine = (line: string): string[] => {
      const fields: string[] = [];
      let field = '';
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (inQ && line[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQ = !inQ;
          }
        } else if (c === delimiter && !inQ) {
          fields.push(field.trim());
          field = '';
        } else {
          field += c;
        }
      }
      fields.push(field.trim());
      return fields;
    };

    const headers = parseLine(lines[0]);
    const rows: any[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = parseLine(lines[i]);
      if (values.every(v => !v)) continue;
      const row: Record<string, any> = {};
      headers.forEach((h, idx) => {
        if (h) row[h] = values[idx] ?? '';
      });
      rows.push(row);
    }

    return rows;
  };

  const handleUploadCases = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const arrayBuffer = event.target?.result as ArrayBuffer;
        let data: any[] = [];

        try {
          const workbook = await loadXlsxWorkbook(new Uint8Array(arrayBuffer));
          if (workbook.worksheets[0]) data = worksheetToJson(workbook.worksheets[0]);
        } catch (xlsxErr) {
          console.warn('[CSV Upload] XLSX read failed, attempting plain text CSV parse:', xlsxErr);
        }

        if (!data || data.length === 0) {
          const decoder = new TextDecoder('utf-8');
          const text = decoder.decode(arrayBuffer);
          data = parseRawCsvText(text);
        }

        if (!data || data.length === 0) {
          toast.error('The uploaded file is empty or could not be parsed.');
          if (uploadInputRef.current) uploadInputRef.current.value = '';
          return;
        }

        // Validate test case types and prevent Non-Functional test cases from being uploaded
        const nonFunctionalRows: number[] = [];
        data.forEach((item, idx) => {
          const rawType = (item.TestType || item.Type || item['Test Type'] || item['test_type'] || '').toString().trim().toLowerCase();
          const isNonFunctional = rawType.includes('non-functional') || 
            rawType.includes('non functional') || 
            rawType === 'nonfunctional' || 
            rawType.includes('performance') || 
            rawType.includes('security') || 
            rawType.includes('load') ||
            rawType.includes('stress');
          
          if (isNonFunctional) {
            nonFunctionalRows.push(idx + 2); // 1-based index including header
          }
        });

        if (nonFunctionalRows.length > 0) {
          if (uploadInputRef.current) uploadInputRef.current.value = '';
          toast.error(`Validation Error: Non-Functional test case(s) detected at row(s): ${nonFunctionalRows.join(', ')}. This module only accepts Functional Test Cases.`);
          return;
        }

        // Folders map to track folder names from CSV if provided
        const folderCasesMap = new Map<string, TestCase[]>();

        const newCases: TestCase[] = data.map((item, idx) => {
          let steps: string[] = [];
          const rawSteps = item.Steps || item.steps || item['Test Steps'] || item['test_steps'] || item['Action'] || item['Procedure'] || item['Steps to Reproduce'] || item['Step Description'] || item['Execution Steps'];
          if (rawSteps) {
            steps = rawSteps.toString().split('\n').map((s: string) => s.trim()).filter((s: string) => s !== '');
          }
          if (steps.length === 0) steps = ['Perform initial action'];

          const getValByKeys = (candidates: string[]) => {
            for (const k of Object.keys(item)) {
              const kNorm = k.toLowerCase().replace(/[^a-z0-9]/g, '');
              for (const cand of candidates) {
                if (kNorm === cand.toLowerCase().replace(/[^a-z0-9]/g, '')) {
                  const val = item[k];
                  if (val !== undefined && val !== null && String(val).trim().length > 0) {
                    return String(val).trim();
                  }
                }
              }
            }
            return undefined;
          };

          const customId = getValByKeys(['Test Case ID', 'testCaseId', 'TestCaseId', 'Test Case Id', 'ID', 'Case ID', 'CaseId', 'TC ID', 'TC-ID', '#']);
          const assignedId = customId ? customId : `TC-MAN-UP-${Date.now().toString().slice(-4)}-${idx + 1}`;

          const folderName = getValByKeys(['Folder', 'Folder Name', 'FolderName', 'Module', 'Module Name', 'ModuleName', 'Component', 'Suite', 'Test Suite', 'Category', 'Section']);

          let candidateDesc = getValByKeys([
            'Description', 'description', 'Test Case Description', 'TestCaseDescription', 'Test Description',
            'Scenario Description', 'Details', 'Summary', 'summary', 'Test Details', 'Case Description', 'Objective', 'Purpose'
          ]);

          let candidateTitle = getValByKeys([
            'Title', 'title', 'Test Case Name', 'Test Name', 'TestCaseName', 'CaseName', 'Summary', 'summary',
            'Test Case Title', 'TestCaseTitle', 'Name', 'name', 'Test Scenario', 'Scenario Title', 'Scenario Name', 'Scenario'
          ]);

          if (!candidateTitle || isGenericTestCaseTitle(candidateTitle)) {
            if (candidateDesc && !isGenericTestCaseTitle(candidateDesc)) {
              candidateTitle = candidateDesc;
            }
          }

          if (!candidateDesc || isGenericTestCaseTitle(candidateDesc)) {
            if (candidateTitle && !isGenericTestCaseTitle(candidateTitle)) {
              candidateDesc = candidateTitle;
            } else {
              for (const k of Object.keys(item)) {
                const kLower = k.toLowerCase();
                if (kLower.includes('step') || kLower.includes('result') || kLower.includes('id') || kLower.includes('type') || kLower.includes('priority') || kLower.includes('folder') || kLower.includes('module')) continue;
                const val = String(item[k] || '').trim();
                if (val.length > 2 && !isGenericTestCaseTitle(val)) {
                  candidateDesc = val;
                  if (!candidateTitle || isGenericTestCaseTitle(candidateTitle)) {
                    candidateTitle = val;
                  }
                  break;
                }
              }
            }
          }

          const expectedResult = getValByKeys(['ExpectedResult', 'expectedResult', 'Expected Result', 'Expected Outcome', 'Expected Results', 'Outcome', 'Expected', 'Expected Behavior']) || 'Verify expected behavior';

          if (!candidateTitle || isGenericTestCaseTitle(candidateTitle)) {
            if (expectedResult && !isGenericTestCaseTitle(expectedResult) && expectedResult.toLowerCase() !== 'verify expected behavior') {
              candidateTitle = expectedResult;
              candidateDesc = expectedResult;
            } else if (steps.length > 0 && steps[0] !== 'Perform initial action' && !isGenericTestCaseTitle(steps[0])) {
              candidateTitle = steps[0];
              candidateDesc = steps[0];
            } else {
              candidateTitle = `Functional Test Case ${idx + 1}`;
              candidateDesc = `Execute verification procedure for functional test case ${idx + 1}.`;
            }
          }

          const finalTitle = candidateTitle;
          const finalDesc = (candidateDesc && !isGenericTestCaseTitle(candidateDesc)) ? candidateDesc : finalTitle;

          const testCaseObj: TestCase = {
            id: `tc_man_up_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 6)}`,
            testCaseId: assignedId,
            title: finalTitle,
            description: finalDesc,
            steps: steps,
            expectedResult: expectedResult,
            status: TestStatus.NOT_EXECUTED,
            isApproved: false,
            testType: TestType.FUNCTIONAL,
            testIntent: TestIntent.POSITIVE,
            priority: TestPriority.MEDIUM,
            isManual: true,
            isUploaded: true
          };

          if (folderName) {
            const normFolderName = folderName.trim();
            if (!folderCasesMap.has(normFolderName)) {
              folderCasesMap.set(normFolderName, []);
            }
            folderCasesMap.get(normFolderName)!.push(testCaseObj);
          }

          return testCaseObj;
        });

        // If folder names were present in the CSV, replicate into Functional Folders in project.scenarios
        let updatedScenarios = [...(project.scenarios || [])];
        if (folderCasesMap.size > 0) {
          folderCasesMap.forEach((folderCases, folderName) => {
            const existingFolderIndex = updatedScenarios.findIndex(
              s => s.scenarioId === 'MANUAL_FOLDER' && s.title.toLowerCase().trim() === folderName.toLowerCase().trim()
            );

            let targetFolderId = '';
            if (existingFolderIndex >= 0) {
              const existingFolder = updatedScenarios[existingFolderIndex];
              targetFolderId = existingFolder.id;
              const combinedCases = [...(existingFolder.testCases || []), ...folderCases];
              const combinedMemberIds = Array.from(new Set([
                ...(existingFolder.memberScenarioIds || []),
                ...folderCases.map(c => c.id)
              ]));
              updatedScenarios[existingFolderIndex] = {
                ...existingFolder,
                testCases: combinedCases,
                memberScenarioIds: combinedMemberIds
              };
            } else {
              targetFolderId = generateUniqueFolderId('manual_folder');
              const newFolderScenario: TestScenario = {
                id: targetFolderId,
                scenarioId: 'MANUAL_FOLDER',
                title: folderName,
                type: 'Functional',
                description: `Functional folder with ${folderCases.length} imported test cases.`,
                expectedResults: 'Group expectations.',
                moduleName: 'Functional Folders',
                isApproved: true,
                testCases: folderCases,
                memberScenarioIds: folderCases.map(c => c.id),
                createdAt: new Date().toISOString()
              };
              updatedScenarios.unshift(newFolderScenario);
            }

            // Assign folderId to those cases
            folderCases.forEach(c => {
              (c as any).folderId = targetFolderId;
              (c as any).isRemovedFromIndividual = true;
              (c as any).saved = true;
            });
          });
        }

        // Always preserve all existing manualTestCases
        const currentAllCases = project.manualTestCases || [];
        const updatedCases = [...newCases, ...currentAllCases];

        const updatedProject: Project = { 
          ...project, 
          manualTestCases: updatedCases,
          scenarios: updatedScenarios
        };
        
        // Immediate synchronous backup so onSnapshot or any refresh does not drop them
        try {
          localStorage.setItem(`automatiqa_project_backup_${project.id}`, JSON.stringify(updatedProject));
          const cached = localStorage.getItem('automatiqa_projects_cache');
          if (cached) {
            const list = JSON.parse(cached);
            const next = list.map((p: any) => p.id === project.id ? updatedProject : p);
            localStorage.setItem('automatiqa_projects_cache', JSON.stringify(next));
          }
        } catch (e) {}

        onUpdateProject(updatedProject);
        await logActivity(user.email, user.name, `Imported ${newCases.length} Functional Test Cases via CSV/Excel`, project.id, project.name);
        
        if (uploadInputRef.current) uploadInputRef.current.value = '';
        toast.success(`Successfully imported ${newCases.length} functional test case${newCases.length > 1 ? 's' : ''}${folderCasesMap.size > 0 ? ` across ${folderCasesMap.size} folder(s)` : ''}.`);
      } catch (err) {
        console.error('[CSV Upload Error]', err);
        toast.error('Failed to parse file. Please ensure you are using a valid CSV or Excel file.');
      }
    };
    reader.readAsArrayBuffer(file as Blob);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 pb-20">
      {/* Header Panel */}
      <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        <div>
          <h2 className="text-2xl font-black text-black uppercase tracking-tight">Functional Test Cases</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
            <input 
              type="text" 
              placeholder="Search IDs or titles..." 
              value={searchQuery || ''}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[10px] font-bold focus:ring-2 focus:ring-indigo-500 outline-none w-48 shadow-inner"
            />
          </div>
          
          <button onClick={() => handleDownloadTemplate('excel')} className="flex items-center gap-1.5 text-slate-600 font-bold text-[10px] bg-white px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 transition-all shadow-sm active:scale-95 cursor-pointer" title="Download Template (Excel)">
            <FileSpreadsheet size={14} /> Template
          </button>
          
          <button onClick={() => uploadInputRef.current?.click()} className="flex items-center gap-1.5 text-slate-600 font-bold text-[10px] bg-white px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 transition-all shadow-sm active:scale-95 cursor-pointer" title="Upload Cases (Excel/CSV)">
            <Upload size={14} /> Upload
            <input type="file" ref={uploadInputRef} className="hidden" accept=".xlsx,.csv" onChange={handleUploadCases} />
          </button>

          <button onClick={() => handleDownloadExcel('excel')} className="flex items-center gap-1.5 text-emerald-700 font-bold text-[10px] bg-emerald-50 px-3 py-2 rounded-lg border border-emerald-200 hover:bg-emerald-100 transition-all shadow-sm cursor-pointer" title="Export All to Excel">
            <FileSpreadsheet size={14} className="text-emerald-600" /> Excel
          </button>

          <button onClick={() => handleDownloadExcel('csv')} className="flex items-center gap-1.5 text-slate-600 font-bold text-[10px] bg-white px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 transition-all shadow-sm cursor-pointer" title="Export All to CSV">
            <Download size={14} className="text-slate-600" /> CSV
          </button>

          <button onClick={handleOpenAddCase} className="flex items-center gap-1.5 bg-indigo-600 text-white px-4 py-2 rounded-lg font-bold text-[10px] uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 active:scale-95">
            <Plus size={14} /> Add Test Case
          </button>

          <button onClick={() => openFolderModal()} className="flex items-center gap-1.5 text-indigo-600 bg-indigo-50 px-3 py-2 rounded-lg font-bold text-[10px] border border-indigo-100 hover:bg-indigo-100 transition-all shadow-sm active:scale-95">
            <FolderPlus size={14} /> Add Folder
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-8 border-b border-slate-200 px-4">
        <button onClick={() => setActiveTab('cases')} className={`pb-4 text-[14px] font-black uppercase tracking-widest relative transition-all ${activeTab === 'cases' ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}>
          <div className="flex items-center gap-2">
            <LayoutGrid size={14} /> Individual Cases
            <span className="bg-slate-100 text-slate-500 px-2.5 py-0.5 rounded-lg text-[10px] font-black">{unorganizedCasesCount}</span>
          </div>
          {activeTab === 'cases' && <div className="absolute bottom-0 left-0 right-0 h-1 bg-indigo-600 rounded-t-full shadow-lg" />}
        </button>
        <button onClick={() => setActiveTab('folders')} className={`pb-4 text-[14px] font-black uppercase tracking-widest relative transition-all ${activeTab === 'folders' ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}>
          <div className="flex items-center gap-2">
            <Folder size={14} /> Functional Folders
            <span className="bg-slate-100 text-slate-500 px-2.5 py-0.5 rounded-lg text-[10px] font-black">{manualFolders.length}</span>
          </div>
          {activeTab === 'folders' && <div className="absolute bottom-0 left-0 right-0 h-1 bg-indigo-600 rounded-t-full shadow-lg" />}
        </button>
      </div>

      {/* Content Area */}
      <div className="space-y-4">
        {activeTab === 'cases' ? (
          <div className="space-y-4">
            {/* Bulk Actions Bar */}
            {filteredCases.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-2xl px-6 py-3.5 flex flex-wrap items-center justify-between gap-4 shadow-sm">
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={handleToggleSelectAll}
                    className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-slate-700 hover:text-indigo-600 transition-colors cursor-pointer"
                  >
                    {allFilteredSelected ? (
                      <CheckSquare size={18} className="text-indigo-600" />
                    ) : (
                      <Square size={18} className="text-slate-400" />
                    )}
                    <span>
                      {allFilteredSelected ? 'Deselect All' : `Select All (${filteredCases.length})`}
                    </span>
                  </button>

                  {bulkSelectedCaseIds.size > 0 && (
                    <span className="text-[11px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 px-3 py-0.5 rounded-full">
                      {bulkSelectedCaseIds.size} Selected
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      if (bulkSelectedCaseIds.size === 0) {
                        toast.error('Please select at least one test case to delete');
                        return;
                      }
                      setDeleteTarget({
                        type: 'bulk_cases',
                        ids: Array.from(bulkSelectedCaseIds)
                      });
                    }}
                    className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all cursor-pointer ${
                      bulkSelectedCaseIds.size > 0
                        ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-md shadow-rose-100 active:scale-95'
                        : 'bg-white hover:bg-rose-50 text-rose-600 border border-rose-200 shadow-sm'
                    }`}
                    title={bulkSelectedCaseIds.size > 0 ? `Delete ${bulkSelectedCaseIds.size} selected test case(s)` : 'Select test cases to delete'}
                  >
                    <Trash2 size={15} />
                    <span>Bulk Delete {bulkSelectedCaseIds.size > 0 ? `(${bulkSelectedCaseIds.size})` : ''}</span>
                  </button>

                  {bulkSelectedCaseIds.size > 0 && (
                    <button
                      type="button"
                      onClick={handleOpenBulkMoveToFolder}
                      className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-[11px] font-black uppercase tracking-widest transition-all shadow-md shadow-indigo-100 active:scale-95 cursor-pointer"
                      title={`Move ${bulkSelectedCaseIds.size} selected test case(s) to a folder`}
                    >
                      <FolderInput size={15} />
                      <span>Move to Folder ({bulkSelectedCaseIds.size})</span>
                    </button>
                  )}

                  {bulkSelectedCaseIds.size > 0 && (
                    <button
                      type="button"
                      onClick={() => handleBulkApprove()}
                      className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-[11px] font-black uppercase tracking-widest transition-all shadow-md shadow-emerald-100 active:scale-95 cursor-pointer"
                    >
                      <CheckCircle2 size={15} />
                      <span>Approve Selected ({bulkSelectedCaseIds.size})</span>
                    </button>
                  )}

                  {unapprovedCases.length > 0 && (
                    <button
                      type="button"
                      onClick={() => handleBulkApprove(unapprovedCases.map(c => c.id))}
                      className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-[11px] font-black uppercase tracking-widest transition-all shadow-md shadow-indigo-100 active:scale-95 cursor-pointer"
                      title="Bulk approve all pending unapproved test cases in this view"
                    >
                      <Check size={15} strokeWidth={3} />
                      <span>Bulk Approve All ({unapprovedCases.length} Pending)</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4">
              {filteredCases.length === 0 ? (
                <div className="p-32 text-center bg-white border-2 border-dashed border-slate-200 rounded-[3rem] opacity-30">
                  <BookOpen size={64} className="text-slate-300 mx-auto mb-6" />
                  <p className="text-sm font-black uppercase tracking-[0.2em] text-slate-500">Repository Empty</p>
                </div>
              ) : (
                filteredCases.map((tc, idx) => (
                  <div key={tc.id} className="bg-white p-6 rounded-[2.5rem] border border-slate-200 shadow-sm hover:border-indigo-400 transition-all group animate-in slide-in-from-bottom-2">
                    <div className="flex items-start justify-between gap-6">
                      <div className="flex items-start gap-4 flex-1 min-w-0">
                        {/* Checkbox for Bulk Selection */}
                        <div 
                          onClick={(e) => handleToggleSelectCase(tc.id, e)}
                          className="pt-2 cursor-pointer text-slate-300 hover:text-indigo-600 transition-colors flex-shrink-0"
                          title={bulkSelectedCaseIds.has(tc.id) ? "Deselect test case" : "Select test case"}
                        >
                          {bulkSelectedCaseIds.has(tc.id) ? (
                            <CheckSquare size={22} className="text-indigo-600" />
                          ) : (
                            <Square size={22} />
                          )}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-4 mb-4">
                            <span className="w-10 h-10 rounded-2xl bg-slate-50 border border-slate-100 flex items-center justify-center text-xs font-black text-slate-400 shadow-inner">{idx + 1}</span>
                            {tc.testCaseId && (
                              <span className="bg-slate-900 text-white px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest flex items-center gap-1">
                                <Hash size={10} />
                                {tc.testCaseId}
                              </span>
                            )}
                            <h4 className="text-base font-black text-black uppercase tracking-tight break-words whitespace-normal leading-relaxed line-clamp-2" title={getTestCaseDisplayTitle(tc)}>{getTestCaseDisplayTitle(tc)}</h4>
                            <div className="flex items-center gap-2">
                              {(() => {
                                const badge = getExecutionClassBadge(tc.testType);
                                return (
                                  <span className={`px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border shadow-sm ${badge.className}`}>
                                    {badge.label}
                                  </span>
                                );
                              })()}
                              <span className={`px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border shadow-sm ${tc.testIntent === 'Positive' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 'bg-red-50 text-red-600 border-red-100'}`}>{tc.testIntent}</span>
                              {tc.priority && <span className={`text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5 ml-2 ${tc.priority === 'High' ? 'text-rose-500' : tc.priority === 'Medium' ? 'text-amber-500' : 'text-slate-400'}`}><Zap size={12} fill="currentColor" /> {tc.priority}</span>}
                            </div>
                          </div>
                          {(() => {
                            const displayDesc = getTestCaseDisplayDescription(tc);
                            return displayDesc ? (
                              <p className="text-xs text-slate-500 font-medium mb-3 ml-1">{displayDesc}</p>
                            ) : null;
                          })()}
                          <div className="bg-indigo-50/30 p-4 rounded-2xl border border-indigo-100/50 mb-5">
                             <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-1">Expected Outcome</p>
                             <p className="text-sm text-indigo-900 font-bold leading-relaxed">{tc.expectedResult}</p>
                          </div>
                          <div className="space-y-2 ml-1">
                            {tc.steps.map((step, sidx) => (
                              <div key={sidx} className="flex gap-3 text-xs text-slate-600 font-medium">
                                <span className="font-black text-slate-300 w-4">{sidx + 1}.</span>
                                <p className="break-words">{step}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button 
                        onClick={(e) => handleApproveCase(tc.id, e)} 
                        disabled={tc.isApproved}
                        className={`flex items-center gap-2 px-5 py-3 rounded-2xl font-bold text-[10px] uppercase tracking-widest transition-all shadow-md active:scale-95 border ${
                          tc.isApproved 
                            ? 'bg-emerald-600 text-white border-emerald-700 shadow-emerald-100 cursor-default' 
                            : 'bg-white text-emerald-600 border-emerald-200 hover:bg-emerald-50/50 hover:border-emerald-300'
                        }`}
                      >
                        {tc.isApproved ? (
                          <>
                            <CheckCircle2 size={16} /> Approved
                          </>
                        ) : (
                          <>
                            <Check size={16} strokeWidth={3} /> Approve
                          </>
                        )}
                      </button>
                      <button 
                        onClick={(e) => handleOpenSingleMoveToFolder(tc, e)} 
                        className="p-3 bg-white text-slate-400 border border-slate-100 hover:text-indigo-600 hover:bg-indigo-50 hover:border-indigo-100 rounded-2xl transition-all shadow-sm cursor-pointer" 
                        title="Move to Folder"
                      >
                        <FolderInput size={20} />
                      </button>
                      <button onClick={(e) => handleOpenEditCase(tc, e)} className="p-3 bg-white text-slate-300 border border-slate-100 hover:text-indigo-600 hover:bg-indigo-50 hover:border-indigo-100 rounded-2xl transition-all shadow-sm" title="Edit Metadata">
                        <Pencil size={20} />
                      </button>
                      <button onClick={(e) => triggerDeleteCase(tc.id, e)} className="p-3 bg-white text-slate-300 border border-slate-100 hover:text-rose-500 hover:bg-rose-50 hover:border-rose-100 rounded-2xl transition-all shadow-sm" title="Remove Artifact">
                        <Trash2 size={20} />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredFolders.length === 0 ? (
              <div className="p-32 text-center bg-white border-2 border-dashed border-slate-200 rounded-[3rem] opacity-30">
                <Folder size={64} className="text-slate-300 mx-auto mb-6" />
                <p className="text-sm font-black uppercase tracking-[0.2em] text-slate-500">No Functional Folders Detected</p>
              </div>
            ) : (
              filteredFolders.map(folder => (
                <div key={folder.id} className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden animate-in zoom-in-95 duration-300">
                  <div className={`p-6 flex items-center justify-between transition-all ${expandedItems.has(folder.id) ? 'bg-slate-50 border-b border-slate-100' : 'hover:bg-slate-50 cursor-pointer'}`}>
                    <div className="flex items-center gap-6">
                       <button onClick={() => toggleExpand(folder.id)} className={`p-2 transition-all rounded-xl ${expandedItems.has(folder.id) ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
                          {expandedItems.has(folder.id) ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                       </button>
                       <div className="p-4 bg-white rounded-2xl text-amber-500 shadow-sm border border-slate-100 transition-transform hover:scale-105">
                          <Folder size={24} />
                       </div>
                       <div>
                          <h4 className="font-black text-black uppercase tracking-tight line-clamp-2 whitespace-normal">{folder.title}</h4>
                          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1 flex items-center gap-2">
                             <CheckSquare size={12} className="text-indigo-400" />
                             {folder.testCases.length} Functional Assets Linked
                          </p>
                       </div>
                    </div>
                    <div className="flex items-center gap-3">
                       {(() => {
                         const folderCases = folder.testCases || [];
                         const allApproved = folderCases.length > 0 && folderCases.every(c => c.isApproved);
                         const unapproved = folderCases.filter(c => !c.isApproved);
                         return (
                           <button
                             onClick={(e) => {
                               e.stopPropagation();
                               if (allApproved) {
                                 toast.info('All test cases in this folder are already approved');
                                 return;
                               }
                               triggerApproveModal(unapproved.length > 0 ? unapproved : folderCases, folder.title);
                             }}
                             disabled={allApproved}
                             className={`flex items-center gap-2 px-5 py-3 rounded-[1.2rem] font-bold text-[10px] uppercase tracking-widest transition-all shadow-md active:scale-95 border ${
                               allApproved
                                 ? 'bg-emerald-600 text-white border-emerald-700 shadow-emerald-100 cursor-default'
                                 : 'bg-white text-emerald-600 border-emerald-200 hover:bg-emerald-50 hover:border-emerald-300 cursor-pointer'
                             }`}
                             title={allApproved ? 'Folder Approved' : 'Approve Folder for Script Generator'}
                           >
                             {allApproved ? (
                               <>
                                 <CheckCircle2 size={16} /> Approved
                               </>
                             ) : (
                               <>
                                 <Check size={16} strokeWidth={3} /> Approve Folder
                               </>
                             )}
                           </button>
                         );
                       })()}
                       <button 
                         onClick={() => onRunFolder && onRunFolder(folder.id)} 
                         className="flex items-center gap-3 px-8 py-3 bg-indigo-600 text-white rounded-[1.2rem] font-black text-[10px] uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 active:scale-95"
                       >
                          <Play size={16} fill="currentColor" /> Run Execution
                       </button>
                       <button onClick={() => openFolderModal(folder)} className="p-3 bg-white text-slate-400 border border-slate-100 hover:text-indigo-600 hover:bg-indigo-50 hover:border-indigo-100 rounded-xl transition-all shadow-sm" title="Manage Collection">
                          <Edit3 size={20} />
                       </button>
                       <button onClick={(e) => triggerDeleteFolder(folder.id, e)} className="p-3 bg-white text-slate-300 border border-slate-100 hover:text-rose-500 hover:bg-rose-50 hover:border-rose-100 rounded-xl transition-all shadow-sm" title="Delete Folder">
                          <Trash2 size={20} />
                       </button>
                    </div>
                  </div>
                  {expandedItems.has(folder.id) && (
                    <div className="p-8 space-y-4 bg-slate-50/50 border-t border-slate-100 animate-in fade-in slide-in-from-top-2">
                       {folder.testCases.length === 0 ? (
                         <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest text-center py-6 italic">No test cases assigned to this folder</p>
                       ) : (
                         folder.testCases.map((tc, tidx) => (
                           <div key={tc.id} className="bg-white p-6 rounded-[2.5rem] border border-slate-200 shadow-sm hover:border-indigo-400 transition-all group animate-in slide-in-from-bottom-2">
                             <div className="flex items-start justify-between gap-6">
                               <div className="flex-1 min-w-0">
                                 <div className="flex flex-wrap items-center gap-4 mb-4">
                                   <span className="w-10 h-10 rounded-2xl bg-slate-50 border border-slate-100 flex items-center justify-center text-xs font-black text-slate-400 shadow-inner">{tidx + 1}</span>
                                   {tc.testCaseId && (
                                     <span className="bg-slate-900 text-white px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest flex items-center gap-1">
                                       <Hash size={10} />
                                       {tc.testCaseId}
                                     </span>
                                   )}
                                   <h4 className="text-base font-black text-black uppercase tracking-tight break-words whitespace-normal leading-relaxed line-clamp-2" title={getTestCaseDisplayTitle(tc)}>{getTestCaseDisplayTitle(tc)}</h4>
                                   <div className="flex items-center gap-2">
                                     {(() => {
                                       const badge = getExecutionClassBadge(tc.testType);
                                       return (
                                         <span className={`px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border shadow-sm ${badge.className}`}>
                                           {badge.label}
                                         </span>
                                       );
                                     })()}
                                     <span className={`px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border shadow-sm ${tc.testIntent === 'Negative' ? 'bg-red-50 text-red-600 border-red-100' : 'bg-emerald-50 text-emerald-600 border-emerald-100'}`}>{tc.testIntent || 'Positive'}</span>
                                     {tc.priority && <span className={`text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5 ml-2 ${tc.priority === 'High' ? 'text-rose-500' : tc.priority === 'Medium' ? 'text-amber-500' : 'text-slate-400'}`}><Zap size={12} fill="currentColor" /> {tc.priority}</span>}
                                   </div>
                                 </div>
                                 {(() => {
                                   const displayDesc = getTestCaseDisplayDescription(tc);
                                   return displayDesc ? (
                                     <p className="text-xs text-slate-500 font-medium mb-3 ml-1">{displayDesc}</p>
                                   ) : null;
                                 })()}
                                 <div className="bg-indigo-50/30 p-4 rounded-2xl border border-indigo-100/50 mb-5">
                                    <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-1">Expected Outcome</p>
                                    <p className="text-sm text-indigo-900 font-bold leading-relaxed">{tc.expectedResult}</p>
                                 </div>
                                 <div className="space-y-2 ml-1">
                                   <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Test Execution Steps ({tc.steps?.length || 0})</p>
                                   {(tc.steps || []).map((step, sidx) => (
                                     <div key={sidx} className="flex gap-3 text-xs text-slate-600 font-medium">
                                       <span className="font-black text-slate-300 w-4">{sidx + 1}.</span>
                                       <p className="break-words">{step}</p>
                                     </div>
                                   ))}
                                 </div>
                               </div>
                               <div className="flex items-center gap-1.5 flex-shrink-0">
                                 <button 
                                   onClick={(e) => handleApproveCase(tc.id, e)} 
                                   disabled={tc.isApproved}
                                   className={`flex items-center gap-2 px-5 py-3 rounded-2xl font-bold text-[10px] uppercase tracking-widest transition-all shadow-md active:scale-95 border ${
                                     tc.isApproved 
                                       ? 'bg-emerald-600 text-white border-emerald-700 shadow-emerald-100 cursor-default' 
                                       : 'bg-white text-emerald-600 border-emerald-200 hover:bg-emerald-50/50 hover:border-emerald-300'
                                   }`}
                                 >
                                   {tc.isApproved ? (
                                     <>
                                       <CheckCircle2 size={16} /> Approved
                                     </>
                                   ) : (
                                     <>
                                       <Check size={16} strokeWidth={3} /> Approve
                                     </>
                                   )}
                                 </button>
                                 <button onClick={(e) => handleOpenEditCase(tc, e)} className="p-3 bg-white text-slate-300 border border-slate-100 hover:text-indigo-600 hover:bg-indigo-50 hover:border-indigo-100 rounded-2xl transition-all shadow-sm" title="Edit Metadata">
                                   <Pencil size={20} />
                                 </button>
                                 <button onClick={(e) => handleRemoveFromFolder(folder.id, tc.id, e)} className="p-3 bg-white text-slate-300 border border-slate-100 hover:text-amber-500 hover:bg-amber-50 hover:border-amber-100 rounded-2xl transition-all shadow-sm" title="Remove from Folder">
                                   <MinusCircle size={20} />
                                 </button>
                                 <button onClick={(e) => triggerDeleteCase(tc.id, e)} className="p-3 bg-white text-slate-300 border border-slate-100 hover:text-rose-500 hover:bg-rose-50 hover:border-rose-100 rounded-2xl transition-all shadow-sm" title="Remove Artifact">
                                   <Trash2 size={20} />
                                 </button>
                               </div>
                             </div>
                           </div>
                         ))
                       )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Case Creation Modal */}
      {isCaseModalOpen && (
        <div className="fixed inset-0 z-[2000] bg-slate-950/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-2xl rounded-[3.5rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200 border border-white">
            <div className="p-10 bg-slate-50/50 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-5">
                 <div className="p-5 bg-indigo-600 rounded-[1.5rem] text-white shadow-xl shadow-indigo-100"><FileText size={28} /></div>
                 <div>
                    <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tight">{editingCaseId ? 'Update Testcase' : 'Add Test Case'}</h3>
                 </div>
              </div>
              <button onClick={() => setIsCaseModalOpen(false)} className="p-3 text-slate-400 hover:text-slate-600 hover:bg-white rounded-full transition-all border border-transparent"><X size={28} /></button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-10 space-y-10 custom-scrollbar">
               <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                 <div className="space-y-3">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2 block">Case ID</label>
                    <div className="bg-slate-100 border border-slate-200 rounded-2xl px-6 py-4 flex items-center gap-2 text-slate-500">
                       <Hash size={14} />
                       <span className="text-xs font-mono font-bold">{caseForm.testCaseId}</span>
                    </div>
                 </div>
                 <div className="space-y-3 md:col-span-3">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2 flex items-center gap-1.5"><Asterisk size={12} className="text-indigo-50" /> Procedure Title</label>
                    <input 
                      autoFocus
                      value={caseForm.title || ''} 
                      onChange={e => setCaseForm({...caseForm, title: e.target.value})} 
                      className={`w-full px-6 py-4 bg-slate-50 border rounded-[1.5rem] text-sm font-bold outline-none focus:ring-4 ring-indigo-50/5 transition-all shadow-inner ${caseErrors.title ? 'border-rose-300' : 'border-slate-200'}`} 
                      placeholder="e.g. Identity Flow - Password Reset Logic" 
                    />
                    {caseErrors.title && <p className="text-rose-500 text-[10px] font-black mt-2 ml-3 uppercase tracking-widest animate-pulse">{caseErrors.title}</p>}
                 </div>
               </div>

               <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="space-y-3">
                     <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2">Execution Class</label>
                     <div className="relative">
                        <select 
                          value={
                            String(caseForm.testType || '').toLowerCase().includes('non') ? TestType.NON_FUNCTIONAL :
                            String(caseForm.testType || '').toLowerCase().includes('ui') ? TestType.UI :
                            TestType.FUNCTIONAL
                          } 
                          onChange={e => setCaseForm({...caseForm, testType: e.target.value as any})} 
                          className="w-full pl-6 pr-12 py-4 bg-slate-50 border border-slate-200 rounded-2xl text-[11px] font-black uppercase outline-none appearance-none cursor-pointer hover:bg-white transition-all shadow-sm"
                        >
                           <option value={TestType.FUNCTIONAL}>Functional</option>
                           <option value={TestType.NON_FUNCTIONAL}>Non-Functional</option>
                           <option value={TestType.UI}>UI</option>
                        </select>
                        <ChevronDown size={14} className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                     </div>
                  </div>
                  <div className="space-y-3">
                     <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2">Testing Intent</label>
                     <div className="relative">
                        <select value={caseForm.testIntent || ''} onChange={e => setCaseForm({...caseForm, testIntent: e.target.value as any})} className="w-full pl-6 pr-12 py-4 bg-slate-50 border border-slate-200 rounded-2xl text-[11px] font-black uppercase outline-none appearance-none cursor-pointer hover:bg-white transition-all shadow-sm">
                           <option value="Positive">Positive</option>
                           <option value="Negative">Negative</option>
                        </select>
                        <ChevronDown size={14} className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                     </div>
                  </div>
                  <div className="space-y-3">
                     <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2">RMG Priority</label>
                     <div className="relative">
                        <select value={caseForm.priority || ''} onChange={e => setCaseForm({...caseForm, priority: e.target.value as any})} className="w-full pl-6 pr-12 py-4 bg-slate-50 border border-slate-200 rounded-2xl text-[11px] font-black uppercase outline-none appearance-none cursor-pointer hover:bg-white transition-all shadow-sm">
                           <option value="High">High</option>
                           <option value="Medium">Medium</option>
                           <option value="Low">Low</option>
                        </select>
                        <ChevronDown size={14} className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                     </div>
                  </div>
               </div>

               <div className="space-y-6">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2 flex items-center gap-2">
                     <LayoutGrid size={14} className="text-indigo-400" /> Technical Execution Steps
                  </label>
                  <div className="space-y-3">
                     {caseForm.steps.map((step, sidx) => (
                        <div key={sidx} className="flex gap-4 group/step animate-in slide-in-from-left-2" style={{ animationDelay: `${sidx * 40}ms` }}>
                           <div className="w-12 h-14 flex items-center justify-center text-xs font-black text-slate-400 bg-slate-50 rounded-2xl border border-slate-100 shadow-inner flex-shrink-0">{sidx + 1}</div>
                           <div className="flex-1 relative">
                              <input 
                                value={step || ''} 
                                onChange={e => { const next = [...caseForm.steps]; next[sidx] = e.target.value; setCaseForm({...caseForm, steps: next}); }} 
                                className="w-full px-6 py-4 bg-white border border-slate-200 rounded-2xl text-xs font-medium outline-none focus:ring-4 ring-indigo-50 transition-all shadow-sm hover:border-indigo-200" 
                                placeholder="Navigate to URL, Click Login button, etc." 
                              />
                              {caseForm.steps.length > 1 && (
                                <button 
                                  onClick={() => setCaseForm({...caseForm, steps: caseForm.steps.filter((_, i) => i !== sidx)})} 
                                  className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-300 hover:text-rose-500 transition-all opacity-0 group-step/step:opacity-100 p-2 hover:bg-rose-50 rounded-xl"
                                >
                                   <X size={16}/>
                                </button>
                              )}
                           </div>
                        </div>
                     ))}
                  </div>
                  <button onClick={() => setCaseForm({...caseForm, steps: [...caseForm.steps, '']})} className="flex items-center gap-3 text-[11px] font-black uppercase text-indigo-600 hover:text-indigo-800 ml-16 transition-all px-4 py-2 hover:bg-indigo-50 rounded-xl w-fit"><Plus size={16} strokeWidth={3} /> Inject Sequential Step</button>
                  {caseErrors.steps && <p className="text-rose-500 text-[10px] font-black mt-2 ml-16 uppercase tracking-widest">{caseErrors.steps}</p>}
               </div>

               <div className="space-y-3 pt-6 border-t border-slate-50">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2 flex items-center gap-2"><CheckCircle2 size={14} className="text-emerald-500" /> Sign-off Criteria (Expected Outcome)</label>
                  <textarea 
                    value={caseForm.expectedResult || ''} 
                    onChange={e => setCaseForm({...caseForm, expectedResult: e.target.value})} 
                    className={`w-full h-32 px-8 py-6 bg-slate-50 border rounded-[2rem] text-sm font-bold text-indigo-700 outline-none focus:ring-4 ring-indigo-50/5 transition-all resize-none shadow-inner ${caseErrors.expectedResult ? 'border-rose-300' : 'border-slate-200'}`} 
                    placeholder="Describe the non-negotiable success outcome for this procedure..." 
                  />
                  {caseErrors.expectedResult && <p className="text-rose-500 text-[10px] font-black mt-2 ml-3 uppercase tracking-widest">{caseErrors.expectedResult}</p>}
               </div>
            </div>

            <div className="p-10 bg-white border-t border-slate-100 flex gap-5">
               <button 
                 type="button" 
                 onClick={handleSaveTestCase} 
                 disabled={isSavingCase}
                 className="flex-1 py-5 bg-indigo-600 text-white rounded-[2rem] font-black text-xs uppercase tracking-widest hover:bg-indigo-700 shadow-2xl shadow-indigo-100 active:scale-95 transition-all flex items-center justify-center gap-3 cursor-pointer disabled:opacity-50"
               >
                 {isSavingCase ? <Loader2 size={20} className="animate-spin" /> : <Save size={20} />} 
                 {isSavingCase ? 'Saving...' : (editingCaseId ? 'Update Testcase' : 'Save')}
               </button>
               <button 
                 type="button" 
                 onClick={() => setIsCaseModalOpen(false)} 
                 className="flex-1 py-5 bg-slate-100 text-slate-500 rounded-[2rem] font-black text-xs uppercase tracking-widest hover:bg-slate-200 active:scale-95 transition-all cursor-pointer"
               >
                 Cancel Operation
               </button>
            </div>
          </div>
        </div>
      )}

      {/* Folder Modal */}
      {isFolderModalOpen && (
        <div className="fixed inset-0 z-[2000] bg-slate-950/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-xl rounded-[3.5rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200 border border-white">
             <div className="p-10 bg-slate-50/50 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-5">
                   <div className="p-5 bg-indigo-600 rounded-[1.5rem] text-white shadow-xl shadow-indigo-100"><FolderPlus size={28} /></div>
                   <div>
                      <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tight">{editingFolderId ? 'Update Folder' : 'Add Folder'}</h3>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Organize individual procedures into cohesive folders</p>
                   </div>
                </div>
                <button onClick={() => setIsFolderModalOpen(false)} className="p-3 text-slate-400 hover:text-slate-600 hover:bg-white rounded-full transition-all border border-transparent"><X size={28} /></button>
             </div>
             
             <div className="flex-1 overflow-y-auto p-10 space-y-10 custom-scrollbar">
                <div className="space-y-3">
                   <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2">Folder Identifier</label>
                   <input 
                     value={newFolderName || ''} 
                     onChange={e => { setNewFolderName(e.target.value); setFolderError(null); }} 
                     className="w-full px-7 py-5 bg-slate-50 border border-slate-200 rounded-[1.8rem] text-sm font-black outline-none focus:ring-4 ring-indigo-50/5 transition-all shadow-inner" 
                     placeholder="e.g. Identity Management Regression" 
                   />
                </div>
                
                <div className="space-y-6">
                   <div className="flex items-center justify-between px-3">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                        Select Test Cases ({availableCasesForFolderModal.length} Available)
                      </p>
                      {availableCasesForFolderModal.length > 0 && (
                        <button 
                          onClick={handleSelectAllInModal} 
                          className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:bg-indigo-50 px-3 py-1.5 rounded-lg transition-all"
                        >
                          {selectedCaseIds.size === availableCasesForFolderModal.length && availableCasesForFolderModal.length > 0 ? 'Deselect All' : 'Select All Available'}
                        </button>
                      )}
                   </div>
                   <div className="max-h-72 overflow-y-auto rounded-[2rem] border border-slate-100 bg-slate-50/20 p-3 custom-scrollbar space-y-2 shadow-inner">
                      {availableCasesForFolderModal.map(tc => (
                         <div 
                           key={tc.id} 
                           onClick={() => { const next = new Set(selectedCaseIds); if (next.has(tc.id)) next.delete(tc.id); else next.add(tc.id); setSelectedCaseIds(next); setFolderError(null); }} 
                           className={`flex items-center gap-5 p-5 rounded-[1.5rem] border transition-all cursor-pointer ${selectedCaseIds.has(tc.id) ? 'bg-white border-indigo-500 shadow-md ring-1 ring-indigo-50' : 'bg-transparent border-transparent hover:bg-white/60 hover:border-slate-200'}`}
                         >
                            <div className={`transition-all ${selectedCaseIds.has(tc.id) ? 'text-indigo-600 scale-110' : 'text-slate-200'}`}>
                               {selectedCaseIds.has(tc.id) ? <CheckSquare size={28} /> : <Square size={28} />}
                            </div>
                            <div className="min-w-0">
                               <div className="flex items-center gap-2">
                                  {tc.testCaseId && <span className="text-[8px] font-black text-indigo-500 uppercase tracking-widest">{tc.testCaseId}</span>}
                                  <p className="text-sm font-black text-slate-800 uppercase tracking-tight break-words whitespace-normal leading-relaxed line-clamp-2" title={getTestCaseDisplayTitle(tc)}>{getTestCaseDisplayTitle(tc)}</p>
                               </div>
                               <p className="text-[9px] text-slate-400 font-bold uppercase mt-0.5 tracking-widest">{tc.testType} • {tc.testIntent}</p>
                            </div>
                         </div>
                      ))}
                      {availableCasesForFolderModal.length === 0 && (
                        <div className="p-12 text-center">
                           <BookOpen size={32} className="text-slate-200 mx-auto mb-4" />
                           <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] font-semibold">No unassigned test cases available</p>
                           <p className="text-[9px] text-slate-400 mt-1">All test cases have already been moved to folders, or none exist.</p>
                        </div>
                      )}
                   </div>
                </div>
                {folderError && <div className="p-5 bg-rose-50 border border-rose-100 rounded-[1.5rem] text-rose-600 text-[11px] font-black uppercase tracking-widest flex items-center gap-3 animate-in shake duration-500"><AlertTriangle size={18}/> {folderError}</div>}
             </div>
             
             <div className="p-10 bg-white border-t border-slate-100 flex gap-5">
                <button onClick={handleSaveFolder} className="flex-1 py-5 bg-indigo-600 text-white rounded-[2rem] font-black text-xs uppercase tracking-widest hover:bg-indigo-700 shadow-2xl shadow-indigo-100 active:scale-95 transition-all">Save Folder</button>
                <button onClick={() => setIsFolderModalOpen(false)} className="flex-1 py-5 bg-slate-100 text-slate-500 rounded-[2rem] font-black text-xs uppercase tracking-widest hover:bg-slate-200 transition-all">Cancel Operation</button>
             </div>
          </div>
        </div>
      )}

      {/* Move to Folder Modal */}
      {isMoveToFolderModalOpen && (
        <div className="fixed inset-0 z-[3000] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-300">
          <div className="bg-white rounded-[2.5rem] max-w-md w-full p-8 space-y-6 shadow-2xl border border-slate-100 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center shadow-inner">
                  <FolderInput size={22} />
                </div>
                <div>
                  <h3 className="text-lg font-black text-slate-900 tracking-tight">Move to Folder</h3>
                  <p className="text-xs text-slate-500 font-medium">
                    Moving {casesToMove.length} functional test case{casesToMove.length !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsMoveToFolderModalOpen(false)}
                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Folder Mode Switcher */}
            <div className="flex gap-2 p-1.5 bg-slate-100/80 rounded-2xl">
              <button
                type="button"
                onClick={() => { setMoveFolderMode('existing'); setMoveFolderError(null); }}
                className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  moveFolderMode === 'existing'
                    ? 'bg-white text-indigo-600 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Existing Folder
              </button>
              <button
                type="button"
                onClick={() => { setMoveFolderMode('new'); setMoveFolderError(null); }}
                className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  moveFolderMode === 'new'
                    ? 'bg-white text-indigo-600 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Create New Folder
              </button>
            </div>

            {moveFolderMode === 'existing' ? (
              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-700">
                  Select Functional Folder <span className="text-rose-500">*</span>
                </label>
                {manualFolders.length === 0 ? (
                  <div className="p-4 bg-amber-50 rounded-2xl border border-amber-200/80 text-amber-800 text-xs">
                    <p className="font-bold">No existing functional folders found.</p>
                    <button
                      type="button"
                      onClick={() => setMoveFolderMode('new')}
                      className="mt-2 inline-flex items-center gap-1.5 text-xs font-black text-indigo-600 hover:text-indigo-800 cursor-pointer"
                    >
                      <Plus size={12} /> Switch to "Create New Folder"
                    </button>
                  </div>
                ) : (
                  <select
                    value={moveTargetFolderId}
                    onChange={(e) => { setMoveTargetFolderId(e.target.value); setMoveFolderError(null); }}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="" disabled>Choose a destination folder...</option>
                    {manualFolders.map(f => (
                      <option key={f.id} value={f.id}>
                        {f.title} ({f.testCases?.length || 0} cases)
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-700">
                  New Folder Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={moveFolderNewName}
                  onChange={(e) => { setMoveFolderNewName(e.target.value); setMoveFolderError(null); }}
                  placeholder="e.g., User Authentication, Checkout Flows"
                  autoFocus
                  className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-800 focus:outline-none focus:border-indigo-500"
                />
              </div>
            )}

            {moveFolderError && (
              <div className="p-3 bg-rose-50 border border-rose-100 rounded-xl text-rose-600 text-xs font-bold flex items-center gap-2">
                <AlertTriangle size={15} />
                <span>{moveFolderError}</span>
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setIsMoveToFolderModalOpen(false)}
                className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-2xl text-xs font-bold cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={moveFolderMode === 'existing' ? (!moveTargetFolderId || manualFolders.length === 0) : !moveFolderNewName.trim()}
                onClick={handleConfirmMoveToFolder}
                className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-2xl text-xs font-bold cursor-pointer transition-all shadow-md shadow-indigo-100 active:scale-95"
              >
                Move to Folder
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[3000] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-300">
          <div className="bg-white p-10 rounded-[3.5rem] max-w-sm w-full text-center shadow-2xl animate-in zoom-in-95 duration-300 border border-white">
             <div className="w-24 h-24 bg-rose-50 rounded-full flex items-center justify-center mx-auto mb-8 text-rose-500 shadow-inner">
                <AlertTriangle size={44} />
             </div>
             <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tight mb-3 leading-tight">
               {deleteTarget.type === 'bulk_cases'
                 ? `Delete ${deleteTarget.ids?.length || bulkSelectedCaseIds.size} Test Cases?`
                 : deleteTarget.type === 'folder'
                 ? 'Delete Folder?'
                 : 'Delete Test Case?'}
             </h3>
             <p className="text-xs text-slate-500 font-medium leading-relaxed mb-8 px-2">
               {deleteTarget.type === 'bulk_cases'
                 ? `Are you sure you want to permanently delete ${deleteTarget.ids?.length || bulkSelectedCaseIds.size} selected test case(s)? They will be removed from this project. This operation cannot be undone.`
                 : 'This artifact will be permanently purged from the workspace repository. This operation is non-reversible.'}
             </p>
             <div className="flex flex-col gap-3">
                <button 
                  onClick={executeDeletion} 
                  className="w-full py-4 bg-rose-600 text-white rounded-[1.5rem] font-black text-[11px] uppercase tracking-widest hover:bg-rose-700 shadow-xl shadow-rose-100 active:scale-95 transition-all"
                >
                  Yes, Delete {deleteTarget.type === 'bulk_cases' ? `(${deleteTarget.ids?.length || bulkSelectedCaseIds.size})` : ''}
                </button>
                <button 
                  onClick={() => setDeleteTarget(null)} 
                  className="w-full py-4 bg-slate-100 text-slate-500 rounded-[1.5rem] font-black text-[11px] uppercase tracking-widest hover:bg-slate-200 transition-all"
                >
                  Cancel
                </button>
             </div>
          </div>
        </div>
      )}

      {/* Select / Create Functional & Script Generator Folder on Test Case Approval Modal */}
      {approveScriptModal && approveScriptModal.isOpen && (
        <div className="fixed inset-0 z-[6000] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl max-w-xl w-full p-6 shadow-2xl border border-slate-200 space-y-5 animate-in zoom-in-95 duration-200 max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600 shadow-xs">
                  <CheckCircle2 size={20} />
                </div>
                <div>
                  <h3 className="text-base font-black text-slate-900">
                    Approve & Move to Functional Folder
                  </h3>
                  <p className="text-xs text-slate-500 font-medium">
                    Move test cases into a Functional Folder and optionally send them to Script Generator
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setApproveScriptModal(null)}
                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-xl hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <XCircle size={20} />
              </button>
            </div>

            {/* Target Test Cases Information Card */}
            <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-2xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <FileText size={14} className="text-emerald-600" />
                  Approving <strong className="text-emerald-700">{approveScriptModal.testCases.length}</strong> Test Case(s)
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 bg-white border border-slate-200 px-2 py-0.5 rounded-md truncate max-w-[200px]">
                  Source: {approveScriptModal.sourceTitle}
                </span>
              </div>
              
              {approveScriptModal.testCases.length > 0 && (
                <div className="max-h-24 overflow-y-auto space-y-1 pr-1">
                  {approveScriptModal.testCases.map((tc, idx) => (
                    <div key={tc.id || idx} className="text-[11px] text-slate-600 flex items-center gap-1.5 bg-white px-2.5 py-1 rounded-lg border border-slate-100 font-medium">
                      <span className="font-mono font-bold text-teal-700 shrink-0">{tc.testCaseId || `TC-${idx + 1}`}</span>
                      <span className="truncate">{getTestCaseDisplayTitle(tc)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* SECTION 1: Destination Functional Folder */}
            <div className="space-y-3 bg-indigo-50/50 p-4 rounded-2xl border border-indigo-100">
              <div className="flex items-center gap-2">
                <Folder className="text-indigo-600" size={16} />
                <label className="text-xs font-black uppercase tracking-wider text-indigo-950">
                  1. Move to Functional Folder <span className="text-rose-500">*</span>
                </label>
              </div>
              <p className="text-[11px] text-slate-500 font-medium">
                Approved test case(s) will be organized into this Functional Folder in the Functional Test Cases repository.
              </p>

              <div className="grid grid-cols-2 gap-2 bg-slate-200/60 p-1 rounded-xl">
                <button
                  type="button"
                  onClick={() => {
                    const defaultFolder = manualFolders[0];
                    setApproveScriptModal(prev => prev ? ({
                      ...prev,
                      functionalFolderMode: 'existing',
                      selectedFunctionalFolderId: defaultFolder ? defaultFolder.id : '',
                      selectedFunctionalFolderName: defaultFolder ? defaultFolder.title : ''
                    }) : null);
                  }}
                  className={`py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                    approveScriptModal.functionalFolderMode === 'existing'
                      ? 'bg-white text-indigo-700 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Folder size={13} />
                  <span>Existing Folder ({manualFolders.length})</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setApproveScriptModal(prev => prev ? ({
                      ...prev,
                      functionalFolderMode: 'new'
                    }) : null);
                  }}
                  className={`py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                    approveScriptModal.functionalFolderMode === 'new'
                      ? 'bg-white text-indigo-700 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <FolderPlus size={13} />
                  <span>Create New Folder</span>
                </button>
              </div>

              {approveScriptModal.functionalFolderMode === 'existing' && (
                <div>
                  {manualFolders.length === 0 ? (
                    <div className="p-3 bg-white rounded-xl border border-amber-200 text-center space-y-1.5">
                      <p className="text-xs text-amber-800 font-medium">
                        No Functional Folders exist yet. Create a new Functional Folder below.
                      </p>
                      <button
                        type="button"
                        onClick={() => setApproveScriptModal(prev => prev ? ({ ...prev, functionalFolderMode: 'new' }) : null)}
                        className="px-2.5 py-1 bg-indigo-600 text-white rounded-lg text-[11px] font-bold cursor-pointer"
                      >
                        Switch to Create New Folder
                      </button>
                    </div>
                  ) : (
                    <div>
                      <select
                        value={approveScriptModal.selectedFunctionalFolderId}
                        onChange={e => {
                          const targetId = e.target.value;
                          const found = manualFolders.find(f => f.id === targetId);
                          setApproveScriptModal(prev => prev ? ({
                            ...prev,
                            selectedFunctionalFolderId: targetId,
                            selectedFunctionalFolderName: found ? found.title : ''
                          }) : null);
                        }}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      >
                        {manualFolders.map(f => (
                          <option key={f.id} value={f.id}>
                            📁 {f.title} ({f.testCases?.length || 0} cases)
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              {approveScriptModal.functionalFolderMode === 'new' && (
                <div>
                  <input
                    type="text"
                    value={approveScriptModal.newFunctionalFolderName}
                    onChange={e => setApproveScriptModal(prev => prev ? ({ ...prev, newFunctionalFolderName: e.target.value }) : null)}
                    placeholder="e.g. Approved Functional Cases, Checkout Suite"
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>
              )}
            </div>

            {/* SECTION 2: Transfer to Script Generator Folder */}
            <div className="space-y-3 bg-emerald-50/50 p-4 rounded-2xl border border-emerald-100">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={approveScriptModal.sendToScriptGenerator}
                  onChange={e => setApproveScriptModal(prev => prev ? ({ ...prev, sendToScriptGenerator: e.target.checked }) : null)}
                  className="w-4 h-4 text-emerald-600 rounded-md border-slate-300 focus:ring-emerald-500 cursor-pointer"
                />
                <span className="text-xs font-black uppercase tracking-wider text-emerald-950 flex items-center gap-1.5">
                  <Zap size={14} className="text-emerald-600" />
                  2. Also send to Script Generator folder to generate automation scripts
                </span>
              </label>

              {approveScriptModal.sendToScriptGenerator && (
                <div className="space-y-3 pt-1 animate-in fade-in duration-150">
                  <div className="grid grid-cols-2 gap-2 bg-slate-200/60 p-1 rounded-xl">
                    <button
                      type="button"
                      onClick={() => {
                        const defaultFolder = scriptGeneratorFolders[0];
                        setApproveScriptModal(prev => prev ? ({
                          ...prev,
                          scriptFolderMode: 'existing',
                          selectedScriptFolderId: defaultFolder ? defaultFolder.id : '',
                          selectedScriptFolderName: defaultFolder ? defaultFolder.name : ''
                        }) : null);
                      }}
                      className={`py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                        approveScriptModal.scriptFolderMode === 'existing'
                          ? 'bg-white text-emerald-700 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <Folder size={13} />
                      <span>Existing Folder ({scriptGeneratorFolders.length})</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setApproveScriptModal(prev => prev ? ({
                          ...prev,
                          scriptFolderMode: 'new'
                        }) : null);
                      }}
                      className={`py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                        approveScriptModal.scriptFolderMode === 'new'
                          ? 'bg-white text-emerald-700 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <FolderPlus size={13} />
                      <span>Create New Folder</span>
                    </button>
                  </div>

                  {approveScriptModal.scriptFolderMode === 'existing' && (
                    <div>
                      {scriptGeneratorFolders.length === 0 ? (
                        <div className="p-3 bg-white rounded-xl border border-amber-200 text-center space-y-1.5">
                          <p className="text-xs text-amber-800 font-medium">
                            No Script Generator folders exist yet. Please create a new Script Generator folder.
                          </p>
                          <button
                            type="button"
                            onClick={() => setApproveScriptModal(prev => prev ? ({ ...prev, scriptFolderMode: 'new' }) : null)}
                            className="px-2.5 py-1 bg-emerald-600 text-white rounded-lg text-[11px] font-bold cursor-pointer"
                          >
                            Switch to Create New Folder
                          </button>
                        </div>
                      ) : (
                        <select
                          value={approveScriptModal.selectedScriptFolderId}
                          onChange={e => {
                            const targetId = e.target.value;
                            const found = scriptGeneratorFolders.find(f => f.id === targetId);
                            setApproveScriptModal(prev => prev ? ({
                              ...prev,
                              selectedScriptFolderId: targetId,
                              selectedScriptFolderName: found ? found.name : ''
                            }) : null);
                          }}
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                        >
                          {scriptGeneratorFolders.map(f => (
                            <option key={f.id} value={f.id}>
                              📁 {f.name} {f.count > 0 ? `(${f.count} scripts)` : '(Empty)'}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}

                  {approveScriptModal.scriptFolderMode === 'new' && (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={approveScriptModal.newScriptFolderName}
                        onChange={e => setApproveScriptModal(prev => prev ? ({ ...prev, newScriptFolderName: e.target.value }) : null)}
                        placeholder="e.g. Smoke Tests, Checkout Flow Scripts"
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setApproveScriptModal(null)}
                className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-2xl text-xs font-bold transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmApproveToScriptGenerator}
                disabled={
                  (approveScriptModal.functionalFolderMode === 'existing' && (!approveScriptModal.selectedFunctionalFolderId || manualFolders.length === 0)) ||
                  (approveScriptModal.functionalFolderMode === 'new' && !approveScriptModal.newFunctionalFolderName.trim()) ||
                  (approveScriptModal.sendToScriptGenerator && (
                    (approveScriptModal.scriptFolderMode === 'existing' && (!approveScriptModal.selectedScriptFolderId || scriptGeneratorFolders.length === 0)) ||
                    (approveScriptModal.scriptFolderMode === 'new' && !approveScriptModal.newScriptFolderName.trim())
                  ))
                }
                className="flex-2 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-2xl text-xs font-black uppercase tracking-wider transition-all shadow-md shadow-emerald-600/20 flex items-center justify-center gap-2 cursor-pointer active:scale-98"
              >
                <Check size={16} />
                <span>
                  {approveScriptModal.sendToScriptGenerator
                    ? 'Approve & Send to Script Generator'
                    : 'Approve & Move to Functional Folder'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ManualTestCaseManager;
