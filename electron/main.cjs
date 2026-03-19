const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Fit-Running',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  // Load the Vite build output
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  // Remove default menu bar
  win.setMenuBarVisibility(false)
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
