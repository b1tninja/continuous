import { clearBashEndsForTests, noteBashEnd, takeBashEnd } from "./bashExit.js";

describe("bashExit", () => {
  beforeEach(() => clearBashEndsForTests());

  it("returns the end noted for a call, once", () => {
    noteBashEnd("call-1", { exit: 3 });
    expect(takeBashEnd("call-1")).toEqual({ exit: 3 });
    expect(takeBashEnd("call-1")).toBeUndefined();
  });

  it("keeps calls apart", () => {
    noteBashEnd("a", { exit: 1 });
    noteBashEnd("b", { exit: 2 });
    expect(takeBashEnd("b")).toEqual({ exit: 2 });
    expect(takeBashEnd("a")).toEqual({ exit: 1 });
  });

  it("ignores a note with no call id", () => {
    noteBashEnd(undefined, { exit: 9 });
    expect(takeBashEnd("undefined")).toBeUndefined();
    expect(takeBashEnd("")).toBeUndefined();
  });

  it("the last note for a call wins", () => {
    noteBashEnd("c", { exit: 1 });
    noteBashEnd("c", { exit: 0 });
    expect(takeBashEnd("c")).toEqual({ exit: 0 });
  });

  it("drops the oldest notes past a bound, so a turn that never takes them cannot grow it", () => {
    for (let i = 0; i < 260; i++) noteBashEnd(`call-${i}`, { exit: i });
    expect(takeBashEnd("call-0")).toBeUndefined();
    expect(takeBashEnd("call-59")).toBeUndefined();
    expect(takeBashEnd("call-259")).toEqual({ exit: 259 });
    expect(takeBashEnd("call-100")).toEqual({ exit: 100 });
  });
});
