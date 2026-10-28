Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "<工作台>\外壳"
sh.Run "cmd /c ""node_modules\.bin\electron.cmd"" .", 0, False
