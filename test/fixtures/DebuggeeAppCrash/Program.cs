using System;
using System.Threading;

Console.WriteLine("CrashDebuggee starting. PID: " + Environment.ProcessId);
Console.WriteLine("Will throw in 1 second.");
Thread.Sleep(1000);
throw new InvalidOperationException("Unhandled test exception for extension testing");
