using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Threading;

namespace FMMatchLens.Plugin.Memory;

/// <summary>
/// An installed native detour. Disposing it removes the detour.
/// </summary>
internal sealed class NativeDetourHandle : IDisposable
{
    private readonly IDisposable _detour;
    private readonly Delegate _hook;
    private int _disposed;

    internal NativeDetourHandle(IDisposable detour, Delegate hook, nint trampolinePtr, string provider)
    {
        _detour = detour;
        _hook = hook;
        TrampolinePtr = trampolinePtr;
        Provider = provider;
    }

    /// <summary>Entry point that runs the original function, or 0 when the provider does not expose it.</summary>
    public nint TrampolinePtr { get; }

    /// <summary>Which detour API installed the hook, for logs.</summary>
    public string Provider { get; }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _detour.Dispose();
        GC.KeepAlive(_hook);
    }
}

/// <summary>
/// Installs a native function detour with a permanent trampoline on whichever BepInEx 6 IL2CPP build is loaded.
/// <list type="bullet">
/// <item>Older bleeding-edge builds (the Windows builds FMMatchLens was written for) expose
/// <c>BepInEx.Unity.IL2CPP.Hook.INativeDetour.CreateAndApply</c>.</item>
/// <item>Newer builds, including the macOS FM27 package, dropped that interface. There the detour goes through
/// MonoMod.Core's <c>IDetourFactory</c>, preferring BepInEx's own <c>Il2CppDetourFactory</c> (Dobby or Funchook),
/// whose original entry point is a permanent trampoline rather than MonoMod's undo-call-redo one.</item>
/// </list>
/// Everything is resolved by reflection so the plugin compiles against either set of BepInEx DLLs.
/// </summary>
internal static class NativeDetourCompat
{
    private const string LegacyDetourType = "BepInEx.Unity.IL2CPP.Hook.INativeDetour";
    private const string BepInExFactoryType = "BepInEx.Unity.IL2CPP.Hook.Il2CppDetourFactory";

    /// <summary>
    /// Detours <paramref name="target"/> to <paramref name="hook"/>. <paramref name="setOriginal"/> receives a delegate
    /// that calls the original function; where the provider allows it, it is called before the detour goes live so the
    /// hook never runs without an original to forward to. The caller must keep <paramref name="hook"/> alive.
    /// </summary>
    public static NativeDetourHandle CreateAndApply<T>(nint target, T hook, Action<T> setOriginal) where T : Delegate
    {
        if (target == 0) throw new ArgumentException("Target address is zero.", nameof(target));
        if (hook is null) throw new ArgumentNullException(nameof(hook));
        if (setOriginal is null) throw new ArgumentNullException(nameof(setOriginal));

        var legacy = FindType("BepInEx.Unity.IL2CPP", LegacyDetourType);
        return legacy is not null
            ? CreateWithLegacyBepInEx(legacy, target, hook, setOriginal)
            : CreateWithMonoModCore(target, hook, setOriginal);
    }

    /// <summary>Names the provider <see cref="CreateAndApply{T}"/> would use, for diagnostics.</summary>
    public static string DescribeProvider()
    {
        try
        {
            if (FindType("BepInEx.Unity.IL2CPP", LegacyDetourType) is not null) return LegacyDetourType;
            var factory = SelectMonoModFactory(out _, out var name);
            return factory is null ? "none (no INativeDetour and no MonoMod.Core)" : name;
        }
        catch (Exception ex)
        {
            return $"unknown ({ex.GetType().Name}: {ex.Message})";
        }
    }

    private static NativeDetourHandle CreateWithLegacyBepInEx<T>(Type detourType, nint target, T hook, Action<T> setOriginal)
        where T : Delegate
    {
        var method = detourType.GetMethods(BindingFlags.Public | BindingFlags.Static)
            .FirstOrDefault(m => m.Name == "CreateAndApply" && m.IsGenericMethodDefinition && m.GetParameters().Length == 3)
            ?? throw new MissingMethodException(detourType.FullName, "CreateAndApply");

        var args = new object?[] { target, hook, null };
        var detour = Invoke(method.MakeGenericMethod(typeof(T)), null, args)
            ?? throw new InvalidOperationException("INativeDetour.CreateAndApply returned null.");
        var disposable = detour as IDisposable
            ?? throw new InvalidOperationException($"{detour.GetType().FullName} is not IDisposable.");

        if (args[2] is not T original)
        {
            disposable.Dispose();
            throw new InvalidOperationException("INativeDetour.CreateAndApply did not return an original delegate.");
        }

        setOriginal(original);
        var trampoline = detourType.GetProperty("TrampolinePtr")?.GetValue(detour) is nint pointer ? pointer : 0;
        return new NativeDetourHandle(disposable, hook, trampoline, LegacyDetourType);
    }

    private static NativeDetourHandle CreateWithMonoModCore<T>(nint target, T hook, Action<T> setOriginal)
        where T : Delegate
    {
        var factory = SelectMonoModFactory(out var factoryApi, out var provider)
            ?? throw new InvalidOperationException(
                "No native detour API found: this BepInEx build has neither INativeDetour nor MonoMod.Core.");
        var factoryInterface = FindType("MonoMod.Core", "MonoMod.Core.IDetourFactory")!;
        var detourInterface = FindType("MonoMod.Core", "MonoMod.Core.ICoreNativeDetour")
            ?? throw new InvalidOperationException("MonoMod.Core.ICoreNativeDetour not found.");

        if (factoryInterface.GetProperty("SupportsNativeDetourOrigEntrypoint")?.GetValue(factory) is not true)
            throw new NotSupportedException($"{provider} cannot call the original function of a native detour.");

        var create = factoryApi!.GetMethod(
                "CreateNativeDetour",
                BindingFlags.Public | BindingFlags.Static,
                null,
                new[] { factoryInterface, typeof(nint), typeof(nint), typeof(bool) },
                null)
            ?? throw new MissingMethodException("MonoMod.Core.DetourFactory", "CreateNativeDetour");

        var hookPointer = Marshal.GetFunctionPointerForDelegate(hook);
        var detour = Invoke(create, null, new object?[] { factory, target, hookPointer, false })
            ?? throw new InvalidOperationException("CreateNativeDetour returned null.");
        var disposable = detour as IDisposable
            ?? throw new InvalidOperationException($"{detour.GetType().FullName} is not IDisposable.");

        try
        {
            var applied = false;
            var originalPointer = ReadOrigEntrypoint(detourInterface, detour);
            if (originalPointer == 0)
            {
                // Some providers only build the trampoline when the detour is applied.
                Apply(detour);
                applied = true;
                originalPointer = ReadOrigEntrypoint(detourInterface, detour);
            }

            if (originalPointer == 0)
                throw new InvalidOperationException($"{provider} returned no original entry point.");

            setOriginal(Marshal.GetDelegateForFunctionPointer<T>(originalPointer));
            if (!applied) Apply(detour);
            return new NativeDetourHandle(disposable, hook, originalPointer, provider);
        }
        catch
        {
            disposable.Dispose();
            throw;
        }
    }

    private static object? SelectMonoModFactory(out Type? factoryApi, out string provider)
    {
        provider = "none";
        factoryApi = FindType("MonoMod.Core", "MonoMod.Core.DetourFactory");
        if (factoryApi is null) return null;

        var current = factoryApi.GetProperty("Current", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
        if (current?.GetType().FullName == BepInExFactoryType)
        {
            provider = $"MonoMod.Core via {BepInExFactoryType} (current)";
            return current;
        }

        // MonoMod's built-in factory has no Apple Silicon support, so use BepInEx's provider when it is not current.
        var bepInExFactory = FindType("BepInEx.Unity.IL2CPP", BepInExFactoryType);
        if (bepInExFactory is not null)
        {
            var created = Activator.CreateInstance(bepInExFactory, nonPublic: true);
            if (created is not null)
            {
                provider = $"MonoMod.Core via {BepInExFactoryType} (created; current is {current?.GetType().FullName ?? "null"})";
                return created;
            }
        }

        if (current is null) return null;
        provider = $"MonoMod.Core via {current.GetType().FullName}";
        return current;
    }

    private static nint ReadOrigEntrypoint(Type detourInterface, object detour)
    {
        if (detourInterface.GetProperty("HasOrigEntrypoint")?.GetValue(detour) is not true) return 0;
        return detourInterface.GetProperty("OrigEntrypoint")?.GetValue(detour) is nint pointer ? pointer : 0;
    }

    private static void Apply(object detour)
    {
        var detourBase = FindType("MonoMod.Core", "MonoMod.Core.ICoreDetourBase");
        if (detourBase?.GetProperty("IsApplied")?.GetValue(detour) is true) return;
        var apply = detourBase?.GetMethod("Apply", Type.EmptyTypes)
                    ?? detour.GetType().GetMethod("Apply", BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null)
                    ?? throw new MissingMethodException(detour.GetType().FullName, "Apply");
        Invoke(apply, detour, Array.Empty<object?>());
    }

    private static object? Invoke(MethodInfo method, object? instance, object?[] args)
    {
        try
        {
            return method.Invoke(instance, args);
        }
        catch (TargetInvocationException ex) when (ex.InnerException is not null)
        {
            ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
            throw;
        }
    }

    private static Type? FindType(string assemblyName, string fullName)
    {
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (!string.Equals(assembly.GetName().Name, assemblyName, StringComparison.Ordinal)) continue;
            var type = assembly.GetType(fullName, throwOnError: false);
            if (type is not null) return type;
        }

        try
        {
            return Assembly.Load(new AssemblyName(assemblyName)).GetType(fullName, throwOnError: false);
        }
        catch
        {
            return null;
        }
    }
}
