import { createContext, useContext, useState } from "react";

const RegionContext = createContext(null);

export function RegionProvider({ children }) {
  const [selectedRegion, setSelectedRegion] = useState(null);

  return (
    <RegionContext.Provider
      value={{
        selectedRegion,
        setSelectedRegion,
      }}
    >
      {children}
    </RegionContext.Provider>
  );
}

export function useRegion() {
  const context = useContext(RegionContext);

  if (!context) {
    throw new Error("useRegion must be used inside RegionProvider");
  }

  return context;
}