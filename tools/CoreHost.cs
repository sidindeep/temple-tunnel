using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;

// Owns a hidden console for the core so Windows can deliver CTRL_BREAK.
// A job object also terminates the core if this host unexpectedly exits.
class CoreHost {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
  public int cb; public string reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags;
  public short show,reserved2; public IntPtr reservedPtr,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct Info {public IntPtr process,thread;public int pid,tid;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out Info info);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
 [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
 [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr attr,string name);
 [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int type,IntPtr info,uint size);
 [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")] static extern bool FreeConsole();
 [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint type,uint group);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
 static int Main(string[] args) {
  if(args.Length!=2)return 64;
  IntPtr job=CreateJobObject(IntPtr.Zero,null), limits=Marshal.AllocHGlobal(144);
  for(int n=0;n<144;n++)Marshal.WriteByte(limits,n,0);
  Marshal.WriteInt32(limits,16,0x2000);
  bool configured=SetInformationJobObject(job,9,limits,144);Marshal.FreeHGlobal(limits);
  if(!configured){CloseHandle(job);return 65;}
  Startup s=new Startup();s.cb=Marshal.SizeOf(s);s.flags=0x101;s.show=0;
  s.input=GetStdHandle(-10);s.output=GetStdHandle(-11);s.error=GetStdHandle(-12);
  SetHandleInformation(s.input,1,1);SetHandleInformation(s.output,1,1);SetHandleInformation(s.error,1,1);
  Info child;
  bool created=CreateProcess(args[0],new StringBuilder("\""+args[0]+"\" run -c \""+args[1]+"\""),IntPtr.Zero,IntPtr.Zero,true,0x214,IntPtr.Zero,null,ref s,out child);
  if(!created){CloseHandle(job);return 66;}
  if(!AssignProcessToJobObject(job,child.process)){TerminateProcess(child.process,67);CloseHandle(child.thread);CloseHandle(child.process);CloseHandle(job);return 67;}
  ResumeThread(child.thread);CloseHandle(child.thread);
  Thread control=new Thread(delegate(){
   try{Console.ReadLine();}catch{}
   FreeConsole();
   if(AttachConsole((uint)child.pid))GenerateConsoleCtrlEvent(1,(uint)child.pid);
   if(WaitForSingleObject(child.process,2500)!=0)TerminateProcess(child.process,68);
  });control.IsBackground=true;control.Start();
  WaitForSingleObject(child.process,0xffffffff);uint exit;GetExitCodeProcess(child.process,out exit);
  CloseHandle(child.process);CloseHandle(job);return (int)exit;
 }
}
