'use client';
import { createContext, useContext } from 'react';

type PublishFn = (topic: string, payload: object) => void;

const PublishContext = createContext<PublishFn>(() => {});

export const PublishProvider = PublishContext.Provider;

export function usePublish(): PublishFn {
  return useContext(PublishContext);
}
