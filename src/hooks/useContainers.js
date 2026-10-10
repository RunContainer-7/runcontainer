import { useEffect, useState } from "react";
import { listContainers } from "../services/containerService";

const initialContainers = [];

export default function useContainers() {
  const [containers, setContainers] = useState(initialContainers);

  const refreshContainers = () => {
    listContainers().then((items) => {
      if (Array.isArray(items)) {
        setContainers(items);
      }
    });
  };

  useEffect(() => {
    refreshContainers();
  }, []);

  const addContainer = (container) => {
    setContainers((prevContainers) => [...prevContainers, container]);
  };

  const removeContainer = (id) => {
    setContainers((prevContainers) => 
      prevContainers.filter((container) => container.id !== id)
    );
  };

  const updateContainerStatus = (id, status) => {
    setContainers((prevContainers) => 
      prevContainers.map((container) =>
        container.id === id ? { ...container, status } : container
      )
    );
  };

  return {
    containers,
    setContainers,
    addContainer,
    removeContainer,
    updateContainerStatus,
    refreshContainers,
  };
}