const search = document.getElementById('search');
const list = document.getElementById('processList');
const status = document.getElementById('status');
const refreshButton = document.getElementById('refreshButton');
let processes = [];
let busy = false;

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function render() {
  list.replaceChildren();
  const query = search.value.trim().toLocaleLowerCase();
  const visible = processes.filter((process) => process.processName.toLocaleLowerCase().includes(query));
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = query ? 'Ничего не найдено.' : 'Запущенные процессы не найдены.';
    list.append(empty);
    return;
  }
  for (const process of visible) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'process-row';
    row.disabled = busy;
    const name = document.createElement('span');
    name.textContent = process.processName;
    const pid = document.createElement('small');
    pid.textContent = `PID ${process.pid}`;
    row.append(name, pid);
    row.addEventListener('click', () => void addProcess(process));
    list.append(row);
  }
}

async function loadProcesses() {
  if (busy) return;
  busy = true;
  refreshButton.disabled = true;
  setStatus('Загружаем список процессов…');
  try {
    processes = await window.processPicker.list();
    setStatus(`Процессов: ${processes.length}`);
  } catch (error) {
    processes = [];
    setStatus(error.message || 'Не удалось получить список процессов.', true);
  } finally {
    busy = false;
    refreshButton.disabled = false;
    render();
  }
}

async function addProcess(process) {
  if (busy) return;
  busy = true;
  refreshButton.disabled = true;
  render();
  setStatus(`Добавляем ${process.processName}…`);
  try {
    await window.processPicker.add(process);
    await window.processPicker.close();
  } catch (error) {
    setStatus(error.message || 'Не удалось добавить процесс.', true);
    busy = false;
    refreshButton.disabled = false;
    render();
  }
}

search.addEventListener('input', render);
refreshButton.addEventListener('click', () => void loadProcesses());
document.getElementById('closeButton').addEventListener('click', () => void window.processPicker.close());
void loadProcesses();
