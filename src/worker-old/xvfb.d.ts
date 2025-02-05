interface XvfbConstructor {
    /** 
     * the X display to use, defaults to the lowest unused display number >= 99 if reuse is false or 99 if reuse is true.
     */
    displayNum?: number;

    /**
     * whether to reuse an existing Xvfb instance if it already exists on the X display referenced by displayNum.
     */
    reuse?: boolean;

    /**
     * number of milliseconds to wait when starting Xvfb before assuming it failed to start, defaults to 500.
     */
    timeout?: number;

    /**
     * don't pipe Xvfb stderr to the process's stderr.
     */
    silent?: boolean;

    /**
     * Extra arguments to pass to Xvfb.
     */
    xvfb_args?: string[];
  }

declare module "xvfb" {
  class Xvfb {
    constructor();
    constructor(args: XvfbConstructor);

    startSync(): void;
    stopSync(): void;

    start(onStartFunc: (err: unknown, xvfbProcess: ReturnType<typeof import('child_process').spawn>) => void): void;
    stop(onStartFunc: (err: unknown) => void): void;
  }

  export = Xvfb;
}